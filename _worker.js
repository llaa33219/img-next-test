// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 경로 끝의 슬래시 제거
    const path = url.pathname.replace(/\/$/, '');

    // =======================================
    // 1) [POST] /upload 또는 /upload/ => 업로드 처리
    // =======================================
    if (request.method === 'POST' && path === '/upload') {
      const cfReqId = request.headers.get('Cf-Request-Id') || '';

      // ----- 중복 요청 체크 -----
      if (cfReqId) {
        if (requestsInProgress[cfReqId]) {
          console.log(`[Dedup] 중복 요청 감지 => Cf-Request-Id=${cfReqId}. 기존 Promise 공유.`);
          return requestsInProgress[cfReqId].promise;
        } else {
          let resolveFn, rejectFn;
          const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };

          // 일정 시간(1분) 후 메모리 해제
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000));
            delete requestsInProgress[cfReqId];
          })());

          let finalResp;
          try {
            finalResp = await handleUpload(request, env);
            requestsInProgress[cfReqId].resolve(finalResp);
          } catch (err) {
            console.log("handleUpload error:", err);
            const failResp = new Response(
              JSON.stringify({ success: false, error: err.message }),
              { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
            requestsInProgress[cfReqId].reject(failResp);
            finalResp = failResp;
          }
          return finalResp;
        }
      } else {
        return handleUpload(request, env);
      }
    }

    // =======================================
    // 2) [GET] /{코드 또는 커스텀 이름} => R2 파일 or HTML
    // =======================================
    else if (request.method === 'GET' && url.pathname.length > 1) {
      // 정적 에셋(파일명에 . 포함) 제공
      if (url.pathname.includes('.')) {
        return env.ASSETS.fetch(request);
      }
      // 다중 파일 요청
      if (url.pathname.indexOf(',') !== -1) {
        const codes = url.pathname.slice(1).split(',').map(code => decodeURIComponent(code));
        if (url.searchParams.get('raw') === '1') {
          const code = codes[0];
          const object = await env.IMAGES.get(code);
          if (!object) return new Response('Not Found', { status: 404 });
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        }
        const objects = await Promise.all(
          codes.map(async code => ({ code, object: await env.IMAGES.get(code) }))
        );
        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTags += `<video src="https://${url.host}/${code}?raw=1"></video>\n`;
          } else {
            mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
        }
        return new Response(renderHTML(mediaTags, url.host), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }
      // 단일 파일 요청
      else {
        const key = decodeURIComponent(url.pathname.slice(1));
        const object = await env.IMAGES.get(key);
        if (!object) return new Response('Not Found', { status: 404 });
        if (url.searchParams.get('raw') === '1') {
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        } else {
          let mediaTag = "";
          if (object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTag = `<video src="https://${url.host}/${key}?raw=1"></video>\n`;
          } else {
            mediaTag = `<img src="https://${url.host}/${key}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
          return new Response(renderHTML(mediaTag, url.host), {
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          });
        }
      }
    }

    // =======================================
    // 3) 그 외 => 기본 정적 에셋(ASSETS)
    // =======================================
    return env.ASSETS.fetch(request);
  }
};

// =======================
// 메인 업로드 처리 함수
// =======================
async function handleUpload(request, env) {
  const formData = await request.formData();
  const files = formData.getAll('file');
  let customName = formData.get('customName');

  if (!files || files.length === 0) {
    return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/ogg", "video/x-msvideo", "video/avi", "video/msvideo"];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (!allowedImageTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 이미지 형식입니다.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
    } else if (file.type.startsWith('video/')) {
      if (!allowedVideoTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 동영상 형식입니다.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      return new Response(JSON.stringify({ success: false, error: '지원하지 않는 파일 형식입니다.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // =========================
  // 1) 검열: 불량이면 저장 안 하고 에러 반환
  // ===========================
  try {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const r = await handleImageCensorship(file, env);
        if (!r.ok) return r.response;
      } else {
        const r = await handleVideoCensorship(file, env);
        if (!r.ok) return r.response;
      }
    }
  } catch (e) {
    console.log("검열 과정에서 예상치 못한 오류 발생:", e);
    return new Response(JSON.stringify({
      success: false,
      error: `검열 처리 중 오류: ${e.message}`
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // =========================
  // 2) R2 업로드 (검열 통과만 저장)
  // =========================
  let codes = [];
  if (customName && files.length === 1) {
    customName = customName.replace(/ /g, "_");
    const existingObject = await env.IMAGES.get(customName);
    if (existingObject) {
      return new Response(JSON.stringify({
        success: false,
        error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const file = files[0];
    const fileBuffer = await file.arrayBuffer();
    await env.IMAGES.put(customName, fileBuffer, {
      httpMetadata: { contentType: file.type }
    });
    codes.push(customName);
  } else {
    for (const file of files) {
      const code = await generateUniqueCode(env);
      const fileBuffer = await file.arrayBuffer();
      await env.IMAGES.put(code, fileBuffer, {
        httpMetadata: { contentType: file.type }
      });
      codes.push(code);
    }
  }

  const host = request.headers.get('host') || 'example.com';
  const finalUrl = `https://${host}/${codes.join(",")}`;

  console.log(">>> 업로드 완료 =>", finalUrl);

  return new Response(JSON.stringify({ success: true, url: finalUrl }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =======================
// 이미지 검열 - Gemini API 사용
// =======================
async function handleImageCensorship(file, env) {
  try {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return {
        ok: false,
        response: new Response(JSON.stringify({
          success: false,
          error: 'Gemini API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    let imageBase64 = base64;
    try {
      if (buf.byteLength > 3 * 1024 * 1024) {
        const dataUrl = `data:${file.type};base64,${base64}`;
        const resizedResp = await fetch(new Request(dataUrl, {
          cf: { image: { width: 800, height: 800, fit: "inside" } }
        }));
        if (resizedResp.ok) {
          const resizedBlob = await resizedResp.blob();
          const resizedArrayBuffer = await resizedBlob.arrayBuffer();
          imageBase64 = arrayBufferToBase64(resizedArrayBuffer);
        }
      }
    } catch (e) {
      console.log("이미지 리사이징 실패:", e);
    }

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: "이 이미지에 부적절한 콘텐츠가 포함되어 있는지 확인해주세요. 다음 카테고리에 해당하는 내용이 있으면 각 항목에 대해 true/false로 답해주세요:\n1. 노출/선정적 이미지\n2. 폭력/무기\n3. 약물/알코올\n4. 욕설/혐오 표현\n5. 기타 유해 콘텐츠\n\n각 항목에 대해 true/false만 응답하고, 발견된 유해 콘텐츠가 있다면 간략히 설명해주세요."
            },
            {
              inlineData: {
                mimeType: file.type,
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 256
      }
    };

    const analysis = await callGeminiAPI(geminiApiKey, requestBody);
    if (!analysis.success) {
      return {
        ok: false,
        response: new Response(JSON.stringify({
          success: false,
          error: `Gemini API 호출 오류: ${analysis.error}`
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    const inappropriate = isInappropriateContent(analysis.text);
    if (inappropriate.isInappropriate) {
      return {
        ok: false,
        response: new Response(JSON.stringify({
          success: false,
          error: `검열됨: ${inappropriate.reasons.join(", ")}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      };
    }

    return { ok: true };
  } catch (e) {
    console.log("handleImageCensorship error:", e);
    return {
      ok: false,
      response: new Response(JSON.stringify({
        success: false,
        error: `이미지 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    };
  }
}

// =======================
// 동영상 검열 - Gemini Video 파일 업로드 API 사용
// =======================
async function handleVideoCensorship(file, env) {
  try {
    console.log(`비디오 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            success: false,
            error: 'Gemini API 키가 설정되지 않았습니다.',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    // 1) Resumable upload 시작: 메타데이터 요청
    const startResp = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': file.size,
          'X-Goog-Upload-Header-Content-Type': file.type,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: 'video_upload' } }),
      }
    );
    if (!startResp.ok) {
      const err = await startResp.text();
      throw new Error(`Resumable upload start 실패: ${startResp.status} ${err}`);
    }
    const uploadUrl = startResp.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) {
      throw new Error('Resumable 업로드 URL을 가져올 수 없습니다.');
    }

    // 2) 실제 파일 업로드 및 finalize
    const buffer = await file.arrayBuffer();
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': file.size,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: buffer,
    });
    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      throw new Error(`비디오 업로드 실패: ${uploadResp.status} ${err}`);
    }
    let myfile = await uploadResp.json();

    // 3) 파일 처리(PROCESSING → ACTIVE) 대기
    while (myfile.state === 'PROCESSING') {
      console.log('비디오 처리 중...');
      await new Promise((r) => setTimeout(r, 5000));
      const statusResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/files/${encodeURIComponent(myfile.name)}?key=${geminiApiKey}`
      );
      if (!statusResp.ok) {
        throw new Error(`파일 상태 조회 실패: ${statusResp.status}`);
      }
      myfile = await statusResp.json();
    }
    if (myfile.state !== 'ACTIVE') {
      throw new Error(`비디오 파일이 활성 상태가 아닙니다: ${myfile.state}`);
    }

    // 4) Gemini generateContent로 검열 요청
    const requestBody = {
      contents: [
        {
          parts: [
            {
              text:
                "이 비디오에 부적절한 콘텐츠가 포함되어 있는지 확인해주세요. 다음 카테고리에 해당하는 내용이 있으면 true/false로 알려주세요:\n" +
                "1. 노출/선정적 이미지\n2. 폭력/무기\n3. 약물/알코올\n4. 욕설/혐오 표현\n5. 기타 유해 콘텐츠\n\n발견 시 간단히 설명해주세요.",
            },
            {
              file_data: {
                mime_type: file.type,
                file_uri: myfile.uri,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 256,
      },
    };
    const analysis = await callGeminiAPI(geminiApiKey, requestBody);
    if (!analysis.success) {
      throw new Error(analysis.error);
    }
    const inappropriate = isInappropriateContent(analysis.text);
    if (inappropriate.isInappropriate) {
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            success: false,
            error: `검열됨: ${inappropriate.reasons.join(', ')}`,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        ),
      };
    }

    return { ok: true };
  } catch (e) {
    console.log('handleVideoCensorship 오류:', e);
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          success: false,
          error: `동영상 검열 중 오류 발생: ${e.message}`,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
}

// =======================
// Gemini API 호출 함수 (재시도 로직 포함)
// =======================
async function callGeminiAPI(apiKey, requestBody) {
  let retryCount = 0;
  const maxRetries = 3;
  const retryDelay = 2000;

  while (retryCount < maxRetries) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      if (!response.ok) {
        if (response.status === 429 && retryCount < maxRetries - 1) {
          retryCount++;
          console.log(`할당량 초과, 재시도 ${retryCount}/${maxRetries}`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        const errText = await response.text();
        return { success: false, error: `API 오류 (${response.status}): ${errText}` };
      }
      const data = await response.json();
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) {
        return { success: false, error: '유효하지 않은 Gemini API 응답' };
      }
      return { success: true, text: content };
    } catch (e) {
      retryCount++;
      console.log(`API 호출 오류, 재시도 ${retryCount}/${maxRetries}:`, e);
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      return { success: false, error: `API 호출 오류: ${e.message}` };
    }
  }
  return { success: false, error: '최대 재시도 횟수 초과' };
}

// =======================
// 부적절한 내용 분석 함수
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
// MP4 재생길이 간단 추출 함수
// =======================
async function getMP4Duration(file) {
  try {
    const buffer = await file.arrayBuffer();
    const dv = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    for (let i = 0; i < uint8.length - 4; i++) {
      if (uint8[i] === 109 && uint8[i+1] === 118 && uint8[i+2] === 104 && uint8[i+3] === 100) {
        const boxStart = i - 4;
        const version = dv.getUint8(boxStart + 8);
        if (version === 0) {
          const timescale = dv.getUint32(boxStart + 20);
          const duration = dv.getUint32(boxStart + 24);
          return duration / timescale;
        } else if (version === 1) {
          const timescale = dv.getUint32(boxStart + 28);
          const high = dv.getUint32(boxStart + 32);
          const low  = dv.getUint32(boxStart + 36);
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
// 고유 8자 코드 생성
// =======================
async function generateUniqueCode(env, length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await env.IMAGES.get(code);
    if (!existing) return code;
  }
  throw new Error("코드 생성 실패(10회 시도 모두 중복)");
}

// =======================
// ArrayBuffer -> base64
// =======================
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// =======================
// 최종 HTML 렌더
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
        height: 61px;
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.1s ease, box-shadow 0.3s ease;
        font-weight: bold;
        font-size: 18px;
        text-align: center;
    }
    button:hover {}
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
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo" style="width: 120px; height: auto; cursor: pointer;" onclick="location.href='/'">
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
