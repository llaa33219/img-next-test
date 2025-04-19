import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";

// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");

    // ------------------------------
    // A) POST /ai — 오디오 업로드 → AI 처리
    // ------------------------------
    if (request.method === "POST" && path === "/ai") {
      const res = await handleAudioAI(request, env);
      // CORS 허용 (필요시)
      if (request.headers.get("Origin")) {
        res.headers.set("Access-Control-Allow-Origin", "*");
      }
      return res;
    }

    // ------------------------------
    // 1) POST /upload — 기존 파일 업로드 처리
    // ------------------------------
    if (request.method === "POST" && path === "/upload") {
      const cfReqId = request.headers.get("Cf-Request-Id") || "";
      if (cfReqId) {
        // 중복 요청 체크
        if (requestsInProgress[cfReqId]) {
          return requestsInProgress[cfReqId].promise;
        } else {
          let resolveFn, rejectFn;
          const promise = new Promise((res, rej) => {
            resolveFn = res;
            rejectFn = rej;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };
          // 1분 후 캐시 해제
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000));
            delete requestsInProgress[cfReqId];
          })());
          try {
            const resp = await handleUpload(request, env);
            requestsInProgress[cfReqId].resolve(resp);
            return resp;
          } catch (err) {
            const fail = new Response(JSON.stringify({ success: false, error: err.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
            requestsInProgress[cfReqId].reject(fail);
            return fail;
          }
        }
      }
      return handleUpload(request, env);
    }

    // ------------------------------
    // 2) GET /{code or customName} — 이미지/영상 서빙
    // ------------------------------
    if (request.method === "GET" && url.pathname.length > 1) {
      // 정적 에셋 (.js, .css 등)
      if (url.pathname.includes(".")) {
        return env.ASSETS.fetch(request);
      }
      // 다중 파일
      if (url.pathname.includes(",")) {
        const codes = url.pathname.slice(1).split(",").map(decodeURIComponent);
        if (url.searchParams.get("raw") === "1") {
          const object = await env.IMAGES.get(codes[0]);
          if (!object) return new Response("Not Found", { status: 404 });
          const headers = new Headers();
          headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
          return new Response(object.body, { headers });
        }
        const objects = await Promise.all(
          codes.map(async code => ({ code, object: await env.IMAGES.get(code) }))
        );
        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata?.contentType?.startsWith("video/")) {
            mediaTags += `<video controls src="https://${url.host}/${code}?raw=1"></video>\n`;
          } else {
            mediaTags += `<img onclick="toggleZoom(this)" src="https://${url.host}/${code}?raw=1" />\n`;
          }
        }
        return new Response(renderHTML(mediaTags, url.host), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }
      // 단일 파일
      const key = decodeURIComponent(url.pathname.slice(1));
      const object = await env.IMAGES.get(key);
      if (!object) return new Response("Not Found", { status: 404 });
      if (url.searchParams.get("raw") === "1") {
        const headers = new Headers();
        headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
        return new Response(object.body, { headers });
      }
      let tag = "";
      if (object.httpMetadata?.contentType?.startsWith("video/")) {
        tag = `<video controls src="https://${url.host}/${key}?raw=1"></video>\n`;
      } else {
        tag = `<img onclick="toggleZoom(this)" src="https://${url.host}/${key}?raw=1" />\n`;
      }
      return new Response(renderHTML(tag, url.host), {
        headers: { "Content-Type": "text/html; charset=UTF-8" }
      });
    }

    // ------------------------------
    // 3) 기타 — 기본 정적 에셋 제공
    // ------------------------------
    return env.ASSETS.fetch(request);
  }
};

// =======================
// A) /ai 핸들러: 오디오 업로드 → AI 처리
// =======================
async function handleAudioAI(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof Blob)) {
      return new Response(JSON.stringify({ success: false, error: "file 파라미터가 없습니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const ai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
    const arrayBuffer = await file.arrayBuffer();

    // 1) 업로드
    const uploadResp = await ai.files.upload({
      file: arrayBuffer,
      config: { mimeType: file.type, filename: file.name || "audio" }
    });

    // 2) AI 설명 생성
    const genResp = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: createUserContent([
        createPartFromUri(uploadResp.uri, uploadResp.mimeType),
        "Describe this audio clip in detail."
      ])
    });

    const text = genResp.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return new Response(JSON.stringify({ success: true, text }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// =======================
// B) /upload 핸들러: 검열 + R2 업로드
// =======================
async function handleUpload(request, env) {
  const formData = await request.formData();
  const files = formData.getAll("file");
  let customName = formData.get("customName");

  if (!files || files.length === 0) {
    return new Response(JSON.stringify({ success: false, error: "파일이 제공되지 않았습니다." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/ogg", "video/x-msvideo", "video/avi", "video/msvideo"];

  for (const file of files) {
    if (file.type.startsWith("image/")) {
      if (!allowedImageTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: "지원하지 않는 이미지 형식입니다." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    } else if (file.type.startsWith("video/")) {
      if (!allowedVideoTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: "지원하지 않는 동영상 형식입니다." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
    } else {
      return new Response(JSON.stringify({ success: false, error: "지원하지 않는 파일 형식입니다." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // 검열 처리
  try {
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const r = await handleImageCensorship(file, env);
        if (!r.ok) return r.response;
      } else {
        const r = await handleVideoCensorship(file, env);
        if (!r.ok) return r.response;
      }
    }
  } catch (e) {
    console.log("검열 과정 오류:", e);
    return new Response(JSON.stringify({ success: false, error: `검열 처리 중 오류: ${e.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // R2 업로드
  let codes = [];
  if (customName && files.length === 1) {
    customName = customName.replace(/ /g, "_");
    const exists = await env.IMAGES.get(customName);
    if (exists) {
      return new Response(JSON.stringify({ success: false, error: "이미 사용 중인 이름입니다. 다른 이름을 선택해주세요." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    const buf = await files[0].arrayBuffer();
    await env.IMAGES.put(customName, buf, { httpMetadata: { contentType: files[0].type } });
    codes.push(customName);
  } else {
    for (const file of files) {
      const code = await generateUniqueCode(env);
      const buf = await file.arrayBuffer();
      await env.IMAGES.put(code, buf, { httpMetadata: { contentType: file.type } });
      codes.push(code);
    }
  }

  const host = request.headers.get("host") || "example.com";
  const url = `https://${host}/${codes.join(",")}`;
  console.log("업로드 완료:", url);

  return new Response(JSON.stringify({ success: true, url }), {
    headers: { "Content-Type": "application/json" }
  });
}

// =======================
// 이미지 검열
// =======================
async function handleImageCensorship(file, env) {
  try {
    const buf = await file.arrayBuffer();
    let base64 = arrayBufferToBase64(buf);
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return { ok: false, response: new Response(JSON.stringify({ success: false, error: "Gemini API 키 없음" }), { status: 500, headers: { "Content-Type": "application/json" } }) };
    }
    // 리사이징
    try {
      if (buf.byteLength > 3 * 1024 * 1024) {
        const dataUrl = `data:${file.type};base64,${base64}`;
        const resp = await fetch(new Request(dataUrl, { cf: { image: { width: 800, height: 800, fit: "inside" } } }));
        if (resp.ok) {
          const blob = await resp.blob();
          const arr = await blob.arrayBuffer();
          base64 = arrayBufferToBase64(arr);
        }
      }
    } catch (e) { console.log("리사이즈 실패:", e); }
    const requestBody = {
      contents: [{ parts: [{ text: "부적절 콘텐츠 여부 확인", inlineData: { mimeType: file.type, data: base64 } }] }],
      generationConfig: { temperature: 0.1, topK: 40, topP: 0.95, maxOutputTokens: 256 }
    };
    const analysis = await callGeminiAPI(apiKey, requestBody);
    if (!analysis.success) {
      return { ok: false, response: new Response(JSON.stringify({ success: false, error: `API 오류: ${analysis.error}` }), { status: 500, headers: { "Content-Type": "application/json" } }) };
    }
    const bad = isInappropriateContent(analysis.text);
    if (bad.isInappropriate) {
      return { ok: false, response: new Response(JSON.stringify({ success: false, error: `검열됨: ${bad.reasons.join(", ")}` }), { status: 400, headers: { "Content-Type": "application/json" } }) };
    }
    return { ok: true };
  } catch (e) {
    console.log("이미지 검열 오류:", e);
    return { ok: false, response: new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } }) };
  }
}

// =======================
// 동영상 검열
// =======================
async function handleVideoCensorship(file, env) {
  try {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return { ok: false, response: new Response(JSON.stringify({ success: false, error: "Gemini API 키 없음" }), { status: 500, headers: { "Content-Type": "application/json" } }) };
    }
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const fileSizeMB = file.size / (1024 * 1024);
    const numSamples = fileSizeMB <= 5 ? 2 : fileSizeMB <= 15 ? 3 : 4;
    const CHUNK_SIZE = 100000;
    const segments = [];
    // 시작
    segments.push({ label: "시작 부분", data: base64.substring(0, Math.min(CHUNK_SIZE, base64.length)) });
    // 중간
    if (numSamples >= 3 && base64.length > CHUNK_SIZE * 2) {
      const mid = Math.floor(base64.length / 2) - CHUNK_SIZE / 2;
      segments.push({ label: "중간 부분", data: base64.substring(mid, Math.min(mid + CHUNK_SIZE, base64.length)) });
    }
    // 75%
    if (numSamples >= 4 && base64.length > CHUNK_SIZE * 3) {
      const q3 = Math.floor(base64.length * 0.75) - CHUNK_SIZE / 2;
      segments.push({ label: "75% 지점", data: base64.substring(q3, Math.min(q3 + CHUNK_SIZE, base64.length)) });
    }
    // 끝
    segments.push({ label: "끝 부분", data: base64.substring(Math.max(0, base64.length - CHUNK_SIZE)) });

    for (const seg of segments) {
      const requestBody = {
        contents: [{ parts: [{ text: `이 비디오의 ${seg.label}`, inlineData: { mimeType: file.type, data: seg.data } }] }],
        generationConfig: { temperature: 0.1, topK: 40, topP: 0.95, maxOutputTokens: 256 }
      };
      const analysis = await callGeminiAPI(apiKey, requestBody);
      if (!analysis.success) {
        return { ok: false, response: new Response(JSON.stringify({ success: false, error: `동영상 검열 오류 (${seg.label}): ${analysis.error}` }), { status: 500, headers: { "Content-Type": "application/json" } }) };
      }
      const bad = isInappropriateContent(analysis.text);
      if (bad.isInappropriate) {
        return { ok: false, response: new Response(JSON.stringify({ success: false, error: `검열됨 (${seg.label}): ${bad.reasons.join(", ")}` }), { status: 400, headers: { "Content-Type": "application/json" } }) };
      }
    }
    return { ok: true };
  } catch (e) {
    console.log("동영상 검열 오류:", e);
    return { ok: false, response: new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } }) };
  }
}

// =======================
// Gemini API 호출
// =======================
async function callGeminiAPI(apiKey, requestBody) {
  let retryCount = 0, maxRetries = 3, retryDelay = 2000;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;
  while (retryCount < maxRetries) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      });
      if (!res.ok) {
        if (res.status === 429 && retryCount < maxRetries - 1) {
          retryCount++;
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        const txt = await res.text();
        return { success: false, error: `API 오류 (${res.status}): ${txt}` };
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return { success: false, error: "유효하지 않은 응답" };
      return { success: true, text };
    } catch (e) {
      retryCount++;
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: "최대 재시도 횟수 초과" };
}

// =======================
// 부적절 콘텐츠 판정
// =======================
function isInappropriateContent(responseText) {
  const txt = responseText.toLowerCase();
  const reasons = [];
  if (txt.includes("true") && /(노출|선정적|nudity|explicit)/.test(txt)) reasons.push("선정적 콘텐츠");
  if (txt.includes("true") && /(폭력|무기|violence)/.test(txt)) reasons.push("폭력/무기 콘텐츠");
  if (txt.includes("true") && /(약물|알코올|drug|alcohol)/.test(txt)) reasons.push("약물/알코올 관련 콘텐츠");
  if (txt.includes("true") && /(욕설|혐오|hate|offensive)/.test(txt)) reasons.push("욕설/혐오 표현");
  if (txt.includes("true") && /(유해|harmful)/.test(txt)) reasons.push("기타 유해 콘텐츠");
  return { isInappropriate: reasons.length > 0, reasons };
}

// =======================
// MP4 길이 추출
// =======================
async function getMP4Duration(file) {
  try {
    const buf = await file.arrayBuffer();
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length - 4; i++) {
      if (u8[i] === 109 && u8[i+1] === 118 && u8[i+2] === 104 && u8[i+3] === 100) {
        const start = i - 4;
        const version = dv.getUint8(start + 8);
        if (version === 0) {
          const timescale = dv.getUint32(start + 20);
          const duration = dv.getUint32(start + 24);
          return duration / timescale;
        } else {
          const timescale = dv.getUint32(start + 28);
          const high = dv.getUint32(start + 32);
          const low = dv.getUint32(start + 36);
          return (high * 2**32 + low) / timescale;
        }
      }
    }
    return null;
  } catch (e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

// =======================
// 유니크 코드 생성
// =======================
async function generateUniqueCode(env, length = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 10; i++) {
    let code = "";
    for (let j = 0; j < length; j++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const exists = await env.IMAGES.get(code);
    if (!exists) return code;
  }
  throw new Error("코드 생성 실패");
}

// =======================
// ArrayBuffer → Base64
// =======================
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// =======================
// HTML 렌더링
// =======================
function renderHTML(mediaTags, host) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="https://i.imgur.com/2MkyDCh.png" type="image/png">
  <title>이미지 공유</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      align-items: center;
      height: 100vh;
      margin: 0;
      padding: 20px;
      overflow: auto;
    }
  
    .upload-container {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
  
    button {
        background-color: #007BFF;
        /* color: white; */
        /* border: none; */
        /* border-radius: 20px; */
        /* padding: 10px 20px; */
        /* margin: 20px 0; */
        /* width: 600px; */
        height: 61px;
        /* box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2); */
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.1s ease, box-shadow 0.3s ease;
        font-weight: bold;
        font-size: 18px;
        text-align: center;
    }
  
    button:hover {
        /* background-color: #005BDD; */
        /* transform: translateY(2px); */
        /* box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2); */
    }
  
    button:active {
      background-color: #0026a3;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
  
    #fileNameDisplay {
      font-size: 16px;
      margin-top: 10px;
      color: #333;
    }
  
    #linkBox {
      width: 500px;
      height: 40px;
      margin: 20px 0;
      font-size: 16px;
      padding: 10px;
      text-align: center;
      border-radius: 14px;
    }
  
    .copy-button {
      background: url('https://img.icons8.com/ios-glyphs/30/000000/copy.png') no-repeat center;
      background-size: contain;
      border: none;
      cursor: pointer;
      width: 60px;
      height: 40px;
      margin-left: 10px;
      vertical-align: middle;
    }
  
    .link-container {
      display: flex;
      justify-content: center;
      align-items: center;
    }
    
    #imageContainer img {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      max-height: 50vh;
      display: block;
      margin: 20px auto;
      cursor: pointer;
      transition: all 0.3s ease;
      object-fit: contain;
      cursor: zoom-in;
    }
  
    #imageContainer img.landscape {
      width: 40vw;
      height: auto;
      max-width: 40vw;
      cursor: zoom-in;
    }
  
    #imageContainer img.portrait,
    #imageContainer video.portrait {
      width: auto;
      height: 50vh;
      max-width: 40vw;
      cursor: zoom-in;
    }
  
    #imageContainer img.expanded.landscape,
    #imageContainer video.expanded.landscape {
      width: 80vw;
      height: auto;
      max-width: 80vw;
      max-height: 100vh;
      cursor: zoom-out;
    }
  
    #imageContainer img.expanded.portrait,
    #imageContainer video.expanded.portrait {
      width: auto;
      height: 100vh;
      max-width: 80vw;
      max-height: 100vh;
      cursor: zoom-out;
    }
  
    .container {
      text-align: center;
    }
  
    .header-content {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      font-size: 30px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
    }
  
    .header-content img {
      margin-right: 20px;
      border-radius: 14px;
    }
  
    .toggle-button {
      background-color: #28a745;
      color: white;
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      display: none;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      font-size: 24px;
      margin-left: 20px;
    }
  
    .hidden {
      display: none;
    }
  
    .title-img-desktop {
      display: block;
    }
  
    .title-img-mobile {
      display: none;
    }
  
    @media (max-width: 768px) {
      button {
        width: 300px;
      }
      #linkBox {
        width: 200px;
      }
      .header-content {
        font-size: 23px;
      }
      .title-img-desktop {
        display: none;
      }
      .title-img-mobile {
        display: block;
      }
    }
    .player-container video {
        width: 40vw;
        height: auto;
        }
    /* Custom Context Menu Styles */
    .custom-context-menu {
      position: absolute;
      background: white;
      border: 1px solid #ccc;
      padding: 5px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
      z-index: 1000;
      border-radius: 10px;
    }
    .custom-context-menu button {
        display: block;
        width: 100%;
        border: none;
        background: none;
        /* padding: 5px 10px; */
        text-align: left;
        cursor: pointer;
    }
    .custom-context-menu button:hover {
      background: #eee;
    }
  </style>
  <link rel="stylesheet" href="https://llaa33219.github.io/BLOUplayer/videoPlayer.css">
  <script src="https://llaa33219.github.io/BLOUplayer/videoPlayer.js"></script>
</head>
<body>
  <div class="header-content">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/';">
      <h1 class="title-img-desktop">이미지 공유</h1>
      <h1 class="title-img-mobile">이미지<br>공유</h1>
  </div>
  <div id="imageContainer">
    ${mediaTags}
  </div>
  <div class="custom-context-menu" id="customContextMenu" style="display: none;">
      <button id="copyImage">이미지 복사</button>
      <button id="copyImageurl">이미지 링크 복사</button>
      <button id="downloadImage">다운로드</button>
      <button id="downloadImagepng">png로 다운로드</button>
  </div>
  <script>
    function toggleZoom(elem) {
      if (!elem.classList.contains('landscape') && !elem.classList.contains('portrait')) {
        let width=0, height=0;
        if (elem.tagName.toLowerCase()==='img') {
          width=elem.naturalWidth; height=elem.naturalHeight;
        } else if (elem.tagName.toLowerCase()==='video') {
          width=elem.videoWidth; height=elem.videoHeight;
        }
        if(width && height){
          if(width>=height) elem.classList.add('landscape');
          else elem.classList.add('portrait');
        }
      }
      elem.classList.toggle('expanded');
    }
    document.getElementById('toggleButton')?.addEventListener('click',function(){
      window.location.href='/';
    });
    
    // Custom Context Menu Functionality
    let currentImage = null;
    const contextMenu = document.getElementById('customContextMenu');

    document.getElementById('imageContainer').addEventListener('contextmenu', function(e) {
        if(e.target.tagName.toLowerCase() === 'img'){
            e.preventDefault();
            currentImage = e.target;
            contextMenu.style.top = e.pageY + 'px';
            contextMenu.style.left = e.pageX + 'px';
            contextMenu.style.display = 'block';
        }
    });

    // Hide context menu on document click
    document.addEventListener('click', function(e) {
        if(contextMenu.style.display === 'block'){
            contextMenu.style.display = 'none';
        }
    });

    // "이미지 복사" 버튼 클릭
    document.getElementById('copyImage').addEventListener('click', async function(){
        if(currentImage){
            try {
                const response = await fetch(currentImage.src);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({ [blob.type]: blob })
                ]);
                alert('이미지 복사됨');
            } catch(err) {
                alert('이미지 복사 실패: ' + err.message);
            }
        }
    });

    // "이미지 링크 복사" 버튼 클릭
    document.getElementById('copyImageurl').addEventListener('click', async function(){
        if(currentImage){
            try {
                await navigator.clipboard.writeText(currentImage.src);
                alert('이미지 링크 복사됨');
            } catch(err) {
                alert('이미지 링크 복사 실패: ' + err.message);
            }
        }
    });

    // "다운로드" 버튼 클릭 (원본 이미지 다운로드)
    document.getElementById('downloadImage').addEventListener('click', function(){
        if(currentImage){
            const a = document.createElement('a');
            a.href = currentImage.src;
            a.download = 'image';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    });

    // "png로 다운로드" 버튼 클릭 (이미지를 png로 변환하여 다운로드)
    document.getElementById('downloadImagepng').addEventListener('click', function(){
        if(currentImage){
            const canvas = document.createElement('canvas');
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function(){
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(function(blob){
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'image.png';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }, 'image/png');
            };
            img.src = currentImage.src;
        }
    });
  </script>
</body>
</html>`;
}
