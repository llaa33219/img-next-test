// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // (디버그 용) 요청 로그
    // 실제 운영에서 노출 최소화하려면 주석 처리하거나 console.log 제거
    console.log("Incoming Request:", {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers)
    });

    // =======================================
    // 1) [POST] /upload => 업로드 처리
    // =======================================
    if (request.method === 'POST' && url.pathname === '/upload') {
      const cfReqId = request.headers.get('Cf-Request-Id') || '';

      // ----- 중복 요청 체크 -----
      if (cfReqId) {
        // 이미 진행 중인 요청이라면 Promise 공유
        if (requestsInProgress[cfReqId]) {
          console.log(`[Dedup] 중복 요청 감지 => Cf-Request-Id=${cfReqId}. 기존 Promise 공유.`);
          return requestsInProgress[cfReqId].promise;
        }
        // 아니면 새 Promise 등록
        else {
          let resolveFn, rejectFn;
          const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };

          // 일정 시간(1분) 후 메모리 해제
          ctx.waitUntil((async () => {
            await new Promise(r => setTimeout(r, 60000)); // 1분
            delete requestsInProgress[cfReqId];
          })());

          // 실 업로드 처리
          let finalResp;
          try {
            finalResp = await handleUpload(request, env);
            requestsInProgress[cfReqId].resolve(finalResp);
          } catch (err) {
            console.log("handleUpload error:", err);
            const failResp = new Response(
              JSON.stringify({ success: false, error: err.message }),
              { status: 500 }
            );
            requestsInProgress[cfReqId].reject(failResp);
            finalResp = failResp;
          }
          return finalResp;
        }
      }
      // cfReqId 없으면 그냥 업로드 처리
      else {
        return handleUpload(request, env);
      }
    }

    // =======================================
    // 2) [GET] /{코드 또는 커스텀 이름} => R2 파일 or HTML
    // =======================================
    else if (request.method === 'GET' && url.pathname.length > 1) {
      // 만약 요청 경로에 '.'가 포함되어 있다면, 이는 정적 에셋(예: script.min.js, _worker.js 등)이므로 ASSETS에서 제공
      if (url.pathname.includes('.')) {
        return env.ASSETS.fetch(request);
      }
      
      // URL 경로에 콤마(,)가 있으면 다중(자동 생성) 코드로 간주
      if (url.pathname.indexOf(',') !== -1) {
        const codes = url.pathname.slice(1).split(',').map(code => decodeURIComponent(code));
        // raw=1 이면 첫번째 파일만 바이너리 원본 반환
        if (url.searchParams.get('raw') === '1') {
          const code = codes[0];
          const object = await env.IMAGES.get(code);
          if (!object) {
            return new Response('Not Found', { status: 404 });
          }
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        }
        // raw=1 아니면 HTML 페이지 반환
        const objects = await Promise.all(
          codes.map(async code => {
            const object = await env.IMAGES.get(code);
            return { code, object };
          })
        );

        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTags += `<video src="https://${url.host}/${code}?raw=1"></video>\n`;
          } else {
            mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media" onclick="toggleZoom(this)">\n`;
          }
        }
        const htmlContent = renderHTML(mediaTags, url.host);
        return new Response(htmlContent, {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }
      // 콤마가 없으면 단일 파일(커스텀 이름)으로 간주
      else {
        const key = decodeURIComponent(url.pathname.slice(1));
        const object = await env.IMAGES.get(key);
        if (!object) {
          return new Response('Not Found', { status: 404 });
        }
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
          const htmlContent = renderHTML(mediaTag, url.host);
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html; charset=UTF-8" }
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
    return new Response(JSON.stringify({ success: false, error: '파일이 제공되지 않았습니다.' }), { status: 400 });
  }

  // 업로드 가능 파일 형식 제한: 검열 가능한 이미지 형식과 검열 가능한 영상 형식으로 제한
  const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const allowedVideoTypes = ["video/mp4", "video/webm", "video/ogg", "video/x-msvideo", "video/avi", "video/msvideo"];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (!allowedImageTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 이미지 형식입니다.' }), { status: 400 });
      }
    } else if (file.type.startsWith('video/')) {
      if (!allowedVideoTypes.includes(file.type)) {
        return new Response(JSON.stringify({ success: false, error: '지원하지 않는 동영상 형식입니다.' }), { status: 400 });
      }
    } else {
      return new Response(JSON.stringify({ success: false, error: '지원하지 않는 파일 형식입니다.' }), { status: 400 });
    }
  }

  // =========================
  // 1) 검열: 불량이면 저장 안 하고 바로 에러
  // =========================
  try {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const r = await handleImageCensorship(file, env);
        if (!r.ok) return r.response; // 검열 실패 => 즉시 반환
      } else if (file.type.startsWith('video/')) {
        const r = await handleVideoCensorship(file, env);
        if (!r.ok) return r.response; // 검열 실패 => 즉시 반환
      }
    }
  } catch (e) {
    console.log("검열 과정에서 예상치 못한 오류 발생:", e);
    return new Response(JSON.stringify({ 
      success: false, 
      error: `검열 처리 중 오류: ${e.message}` 
    }), { status: 500 });
  }

  // =========================
  // 2) R2 업로드 (검열 통과만 저장)
  // =========================
  let codes = [];
  
  // 사용자 지정 이름 처리 (단일 파일일 때만 가능)
  if (customName && files.length === 1) {
    // 스페이스는 언더스코어로 대체 (다른 커뮤니티에 URL 붙여넣어도 끊기지 않도록)
    customName = customName.replace(/ /g, "_");
    // 이미 존재하는 이름인지 확인
    const existingObject = await env.IMAGES.get(customName);
    if (existingObject) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.' 
      }), { status: 400 });
    }
    
    // 파일 저장 (단일 파일)
    const file = files[0];
    const fileBuffer = await file.arrayBuffer();
    
    // R2에 업로드 (키는 customName 그대로 사용)
    await env.IMAGES.put(customName, fileBuffer, {
      httpMetadata: { contentType: file.type }
    });
    codes.push(customName);
  } 
  // 기본 이름 사용 (자동 생성 코드)
  else {
    for (const file of files) {
      const code = await generateUniqueCode(env);
      const fileBuffer = await file.arrayBuffer();

      // R2에 업로드
      await env.IMAGES.put(code, fileBuffer, {
        httpMetadata: { contentType: file.type }
      });
      codes.push(code);
    }
  }
  
  const host = request.headers.get('host') || 'example.com';
  // URL에 customName이나 자동 생성 코드를 사용할 때 encodeURIComponent 처리 없이 원본 그대로 사용
  const finalUrl = `https://${host}/${codes.join(",")}`;

  console.log(">>> 업로드 완료 =>", finalUrl);

  return new Response(JSON.stringify({ success: true, url: finalUrl }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// =======================
// 동영상 검열 - Gemini API 사용 (파일 업로드 방식)
// =======================
async function handleVideoCensorship(file, env) {
  try {
    // (1) 용량 제한 - 50MB
    if (file.size > 50 * 1024 * 1024) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ 
          success: false, 
          error: "영상 용량 50MB 초과" 
        }), { status: 400 })
      };
    }

    // (2) 동영상 길이 제한 - 5분
    let videoDuration = await getMP4Duration(file);
    if (videoDuration && videoDuration > 300) { // 5분 초과
      return {
        ok: false,
        response: new Response(JSON.stringify({ 
          success: false, 
          error: "영상 길이 5분 초과" 
        }), { status: 400 })
      };
    }

    // (3) Gemini API 키 확인
    const geminiApiKey = env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ 
          success: false, 
          error: 'Gemini API 키가 설정되지 않았습니다.' 
        }), { status: 500 })
      };
    }

    // (4) 파일 업로드 준비
    const fileBuffer = await file.arrayBuffer();
    const fileBlob = new Blob([fileBuffer], { type: file.type });
    
    // (5) Gemini 파일 업로드 API 호출
    try {
      // 파일 업로드용 FormData 생성
      const formData = new FormData();
      formData.append('file', fileBlob, file.name || 'video.mp4');
      
      // 업로드 API 호출
      const uploadResponse = await fetch(`https://generativelanguage.googleapis.com/v1/media:upload?key=${geminiApiKey}`, {
        method: 'POST',
        body: formData
      });
      
      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.log("파일 업로드 실패:", errorText);
        return {
          ok: false,
          response: new Response(JSON.stringify({ 
            success: false, 
            error: `파일 업로드 실패: ${uploadResponse.status}` 
          }), { status: uploadResponse.status })
        };
      }
      
      // 업로드 응답에서 파일 URI 추출
      const uploadResult = await uploadResponse.json();
      if (!uploadResult.uri) {
        return {
          ok: false,
          response: new Response(JSON.stringify({ 
            success: false, 
            error: "파일 업로드 응답에 URI가 없습니다" 
          }), { status: 500 })
        };
      }
      
      const fileUri = uploadResult.uri;
      console.log("파일 업로드 성공, URI:", fileUri);
      
      // (6) 파일 처리 상태 확인 (옵션)
      let fileActive = false;
      let checkAttempts = 0;
      const maxCheckAttempts = 5;
      
      while (!fileActive && checkAttempts < maxCheckAttempts) {
        const fileStatusResponse = await fetch(`https://generativelanguage.googleapis.com/v1/media/${fileUri}?key=${geminiApiKey}`);
        
        if (fileStatusResponse.ok) {
          const fileStatus = await fileStatusResponse.json();
          if (fileStatus.state === "ACTIVE") {
            fileActive = true;
            console.log("파일 처리 완료됨");
          } else if (fileStatus.state === "PROCESSING") {
            console.log("파일 처리 중...");
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3초 대기
          } else {
            return {
              ok: false,
              response: new Response(JSON.stringify({ 
                success: false, 
                error: `파일 처리 실패: ${fileStatus.state}` 
              }), { status: 500 })
            };
          }
        } else {
          console.log("파일 상태 확인 실패");
          // 상태 확인 실패해도 계속 진행 (선택적)
          fileActive = true;
        }
        
        checkAttempts++;
      }
      
      // (7) 비디오 콘텐츠 분석 요청
      const contentAnalysisBody = {
        contents: [
          {
            parts: [
              {
                text: "이 비디오를 분석하고 부적절한 콘텐츠가 포함되어 있는지 확인해주세요. 다음 카테고리에 해당하는 내용이 있으면 각 항목에 대해 true/false로 답해주세요:\n1. 노출/선정적 이미지\n2. 폭력/무기\n3. 약물/알코올\n4. 욕설/혐오 표현\n5. 기타 유해 콘텐츠"
              },
              {
                fileData: {
                  mimeType: file.type,
                  fileUri: fileUri
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 512,
        }
      };
      
      // 분석 요청 전송
      const analysisResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiApiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(contentAnalysisBody)
      });
      
      if (!analysisResponse.ok) {
        const errorText = await analysisResponse.text();
        console.log("콘텐츠 분석 실패:", errorText);
        
        // 일시적인 오류면 허용
        if (analysisResponse.status >= 500) {
          console.log("서버 오류, 임시로 허용");
          return { ok: true };
        }
        
        return {
          ok: false,
          response: new Response(JSON.stringify({ 
            success: false, 
            error: `비디오 분석 실패: ${analysisResponse.status}` 
          }), { status: analysisResponse.status })
        };
      }
      
      // 분석 결과 처리
      const analysisResult = await analysisResponse.json();
      
      if (analysisResult.candidates && 
          analysisResult.candidates[0] && 
          analysisResult.candidates[0].content && 
          analysisResult.candidates[0].content.parts) {
        
        const responseText = analysisResult.candidates[0].content.parts[0].text;
        console.log("분석 결과:", responseText);
        
        // 부적절한 콘텐츠 확인
        const inappropriate = isInappropriateContent(responseText);
        
        if (inappropriate.isInappropriate) {
          return {
            ok: false,
            response: new Response(JSON.stringify({ 
              success: false, 
              error: `검열됨: ${inappropriate.reasons.join(", ")}` 
            }), { status: 400 })
          };
        }
      }
      
      return { ok: true };
      
    } catch (uploadError) {
      console.log("비디오 업로드/분석 오류:", uploadError);
      
      // 심각한 오류가 아니면 임시로 허용
      return { ok: true };
    }
  } catch (e) {
    console.log("handleVideoCensorship 전체 오류:", e);
    // 심각한 오류가 아니면 임시로 허용
    return { ok: true };
  }
}
// =======================
// 부적절한 내용 분석 함수
// =======================
function isInappropriateContent(responseText) {
  const responseTextLower = responseText.toLowerCase();
  const reasons = [];

  if ((responseTextLower.includes("true") && responseTextLower.includes("노출")) || 
      (responseTextLower.includes("true") && responseTextLower.includes("선정적")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("성인물")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("nude")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("nudity")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("explicit")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("sexual"))) {
    reasons.push("선정적 콘텐츠");
  }

  if ((responseTextLower.includes("true") && responseTextLower.includes("폭력")) || 
      (responseTextLower.includes("true") && responseTextLower.includes("무기")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("weapon")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("violence"))) {
    reasons.push("폭력/무기 콘텐츠");
  }

  if ((responseTextLower.includes("true") && responseTextLower.includes("약물")) || 
      (responseTextLower.includes("true") && responseTextLower.includes("알코올")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("drug")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("alcohol"))) {
    reasons.push("약물/알코올 관련 콘텐츠");
  }

  if ((responseTextLower.includes("true") && responseTextLower.includes("욕설")) || 
      (responseTextLower.includes("true") && responseTextLower.includes("혐오")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("hate")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("offensive"))) {
    reasons.push("욕설/혐오 표현");
  }

  if ((responseTextLower.includes("true") && responseTextLower.includes("유해")) ||
      (responseTextLower.includes("true") && responseTextLower.includes("harmful"))) {
    reasons.push("기타 유해 콘텐츠");
  }

  return {
    isInappropriate: reasons.length > 0,
    reasons: reasons
  };
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
      // 'm','v','h','d' => 109,118,104,100
      if (uint8[i]===109 && uint8[i+1]===118 && uint8[i+2]===104 && uint8[i+3]===100) {
        const boxStart = i - 4;
        const version = dv.getUint8(boxStart + 8);
        // version 0
        if (version === 0) {
          const timescale = dv.getUint32(boxStart+20);
          const duration = dv.getUint32(boxStart+24);
          return duration / timescale;
        }
        // version 1
        else if (version === 1) {
          const timescale = dv.getUint32(boxStart+28);
          const high = dv.getUint32(boxStart+32);
          const low  = dv.getUint32(boxStart+36);
          const bigDuration = high * 2**32 + low;
          return bigDuration / timescale;
        }
      }
    }
    return null; // 못 찾음
  } catch(e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

// =======================
// 고유 8자 코드 생성
// =======================
async function generateUniqueCode(env, length=8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await env.IMAGES.get(code);
    if (!existing) return code; // 중복 없으면 리턴
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
  // 이미지/영상을 보여주는 페이지
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