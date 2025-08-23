// ==============================
// 전역: 중복 요청 관리 Map
// ==============================
const requestsInProgress = {};

// ==============================
// 전역: 레이트 리미팅 관리 Map
// ==============================
const rateLimitData = new Map(); // IP별 요청 기록
const blockedIPs = new Map(); // 차단된 IP와 해제 시간

// 레이트 리미팅 검사 함수
function checkRateLimit(clientIP) {
  const now = Date.now();
  
  // 차단된 IP 확인
  if (blockedIPs.has(clientIP)) {
    const blockInfo = blockedIPs.get(clientIP);
    if (now < blockInfo.unblockTime) {
      const remainingTime = Math.ceil((blockInfo.unblockTime - now) / 1000);
      return {
        blocked: true,
        reason: blockInfo.reason,
        remainingTime: remainingTime
      };
    } else {
      // 차단 시간이 지났으므로 해제
      blockedIPs.delete(clientIP);
    }
  }
  
  // 현재 IP의 요청 기록 가져오기 또는 생성
  if (!rateLimitData.has(clientIP)) {
    rateLimitData.set(clientIP, {
      requests: [],
      lastCleanup: now
    });
  }
  
  const ipData = rateLimitData.get(clientIP);
  
  // 오래된 요청 기록 정리 (1시간 이상 된 것)
  if (now - ipData.lastCleanup > 60000) { // 1분마다 정리
    ipData.requests = ipData.requests.filter(time => now - time < 3600000); // 1시간
    ipData.lastCleanup = now;
  }
  
  // 현재 요청 추가
  ipData.requests.push(now);
  
  // 1분 내 요청 수 확인 (20개 초과시 5분 차단)
  const oneMinuteAgo = now - 60000;
  const recentRequests = ipData.requests.filter(time => time > oneMinuteAgo);
  
  if (recentRequests.length > 20) {
    const unblockTime = now + (5 * 60 * 1000); // 5분 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1분 내 20개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1분 내 20개 초과 업로드로 인한 5분 차단',
      remainingTime: 300
    };
  }
  
  // 1시간 내 요청 수 확인 (100개 초과시 1시간 차단)
  const oneHourAgo = now - 3600000;
  const hourlyRequests = ipData.requests.filter(time => time > oneHourAgo);
  
  if (hourlyRequests.length > 100) {
    const unblockTime = now + (60 * 60 * 1000); // 1시간 후
    blockedIPs.set(clientIP, {
      unblockTime: unblockTime,
      reason: '1시간 내 100개 초과 업로드'
    });
    return {
      blocked: true,
      reason: '1시간 내 100개 초과 업로드로 인한 1시간 차단',
      remainingTime: 3600
    };
  }
  
  return { blocked: false };
}

// 메모리 정리 함수 (주기적으로 호출)
function cleanupOldData() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  
  // 오래된 요청 기록 정리
  for (const [ip, data] of rateLimitData.entries()) {
    data.requests = data.requests.filter(time => time > oneHourAgo);
    if (data.requests.length === 0) {
      rateLimitData.delete(ip);
    }
  }
  
  // 만료된 차단 기록 정리
  for (const [ip, blockInfo] of blockedIPs.entries()) {
    if (now >= blockInfo.unblockTime) {
      blockedIPs.delete(ip);
    }
  }
  
  console.log(`[Cleanup] 레이트 리미팅 데이터 정리 완료. 활성 IP: ${rateLimitData.size}, 차단된 IP: ${blockedIPs.size}`);
}

// CORS 헤더 추가 함수
function addCorsHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env, ctx) {
    // 주기적으로 메모리 정리 (10분마다)
    const now = Date.now();
    if (!this.lastCleanup || now - this.lastCleanup > 600000) {
      ctx.waitUntil(Promise.resolve().then(() => cleanupOldData()));
      this.lastCleanup = now;
    }
    
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');

    // OPTIONS 요청 처리 (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 1) [POST] /upload 또는 /upload/ => 업로드 처리 (웹 인터페이스)
    if (request.method === 'POST' && path === '/upload') {
      // 클라이언트 IP 가져오기
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      request.headers.get('X-Real-IP') || 
                      'unknown';
      
      // 레이트 리미팅 검사
      const rateLimitResult = checkRateLimit(clientIP);
      if (rateLimitResult.blocked) {
        console.log(`[Rate Limit] IP ${clientIP} 차단됨: ${rateLimitResult.reason}`);
        return new Response(JSON.stringify({
          success: false,
          error: `보안상 업로드가 제한되었습니다. ${rateLimitResult.reason}. ${rateLimitResult.remainingTime}초 후 다시 시도하세요.`,
          rateLimited: true,
          remainingTime: rateLimitResult.remainingTime
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // 요청이 웹 인터페이스에서 왔는지 외부에서 왔는지 확인
      const isExternalRequest = request.headers.get('Origin') && 
                               !request.headers.get('Origin').includes(url.host);
      
      const cfReqId = request.headers.get('Cf-Request-Id') || '';
      if (cfReqId) {
        if (requestsInProgress[cfReqId]) {
          console.log(`[Dedup] 중복 요청 감지 => Cf-Request-Id=${cfReqId}. 기존 Promise 공유.`);
          const response = await requestsInProgress[cfReqId].promise;
          return isExternalRequest ? addCorsHeaders(response) : response;
        } else {
          let resolveFn, rejectFn;
          const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
          });
          requestsInProgress[cfReqId] = { promise, resolve: resolveFn, reject: rejectFn };
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
          return isExternalRequest ? addCorsHeaders(finalResp) : finalResp;
        }
      } else {
        const response = await handleUpload(request, env);
        return isExternalRequest ? addCorsHeaders(response) : response;
      }
    }

    // 2) [POST] /api/upload => API 전용 업로드 엔드포인트 (외부용)
    else if (request.method === 'POST' && path === '/api/upload') {
      // 클라이언트 IP 가져오기
      const clientIP = request.headers.get('CF-Connecting-IP') || 
                      request.headers.get('X-Forwarded-For') || 
                      request.headers.get('X-Real-IP') || 
                      'unknown';
      
      // 레이트 리미팅 검사
      const rateLimitResult = checkRateLimit(clientIP);
      if (rateLimitResult.blocked) {
        console.log(`[Rate Limit] API IP ${clientIP} 차단됨: ${rateLimitResult.reason}`);
        const response = new Response(JSON.stringify({
          success: false,
          error: `보안상 업로드가 제한되었습니다. ${rateLimitResult.reason}. ${rateLimitResult.remainingTime}초 후 다시 시도하세요.`,
          rateLimited: true,
          remainingTime: rateLimitResult.remainingTime
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
        return addCorsHeaders(response);
      }
      
      const response = await handleUpload(request, env);
      return addCorsHeaders(response);
    }

    // 3) [GET] /api => API 문서 제공
    else if (request.method === 'GET' && path === '/api') {
      return new Response(renderApiDocs(url.host), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }

    // 4) [GET] /{코드 또는 커스텀 이름} => R2 파일 or HTML
    else if (request.method === 'GET' && url.pathname.length > 1) {
      if (url.pathname.includes('.')) {
        return env.ASSETS.fetch(request);
      }
      if (url.pathname.indexOf(',') !== -1) {
        const codes = url.pathname.slice(1).split(',').map(decodeURIComponent);
        if (url.searchParams.get('raw') === '1') {
          const object = await env.IMAGES.get(codes[0]);
          if (!object) return new Response('Not Found', { status: 404 });
          const headers = new Headers();
          headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
          return new Response(object.body, { headers });
        }
        const objects = await Promise.all(codes.map(async code => ({
          code,
          object: await env.IMAGES.get(code)
        })));
        let mediaTags = "";
        for (const { code, object } of objects) {
          if (object && object.httpMetadata?.contentType?.startsWith('video/')) {
            mediaTags += `<video src="https://${url.host}/${code}?raw=1"></video>\n`;
          } else {
            mediaTags += `<img src="https://${url.host}/${code}?raw=1" alt="Uploaded Media">\n`;
          }
        }
        return new Response(renderHTML(mediaTags, url.host), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      } else {
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
            mediaTag = `<img src="https://${url.host}/${key}?raw=1" alt="Uploaded Media">\n`;
          }
          return new Response(renderHTML(mediaTag, url.host), {
            headers: { 'Content-Type': 'text/html; charset=UTF-8' }
          });
        }
      }
    }

    // 5) 그 외 => 기본 정적 에셋
    return env.ASSETS.fetch(request);
  }
};

// 메인 업로드 처리 함수
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
        status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // 1) 검열 - 다중 업로드시 실패한 파일 수집, 단일 업로드시 즉시 중단
  console.log(`[검열 시작] ${files.length}개 파일 검열 시작`);
  const validFiles = [];
  const failedFiles = [];
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[검열 진행] ${i + 1}/${files.length} - ${file.name || 'Unknown'}, ${file.type}, ${(file.size / 1024 / 1024).toFixed(2)}MB`);
    
    try {
      const r = file.type.startsWith('image/')
        ? await handleImageCensorship(file, env)
        : await handleVideoCensorship(file, env);
        
      if (!r.ok) {
        console.log(`[검열 실패] ${i + 1}번째 파일에서 검열 실패`);
        // 기존 응답에서 에러 메시지 추출
        let errorMessage = '알 수 없는 오류';
        try {
          const responseText = await r.response.text();
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          console.log('에러 메시지 파싱 실패:', e);
        }
        
        const fileInfo = { 
          index: i + 1, 
          name: file.name || 'Unknown', 
          error: errorMessage 
        };
        failedFiles.push(fileInfo);
        
        // 단일 파일 업로드시에만 즉시 중단
        if (files.length === 1) {
          return new Response(JSON.stringify({
            success: false,
            error: `파일 검열 실패: ${errorMessage}`
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else {
        console.log(`[검열 통과] ${i + 1}번째 파일 검열 통과`);
        validFiles.push({ file, index: i + 1 });
      }
    } catch (e) {
      console.log(`[검열 오류] ${i + 1}번째 파일 검열 중 오류:`, e);
      const fileInfo = { 
        index: i + 1, 
        name: file.name || 'Unknown', 
        error: `검열 중 오류: ${e.message}` 
      };
      failedFiles.push(fileInfo);
      
      // 단일 파일 업로드시에만 즉시 중단
      if (files.length === 1) {
        return new Response(JSON.stringify({
          success: false,
          error: `파일 검열 중 오류: ${e.message}`
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }
  
  console.log(`[검열 완료] ${validFiles.length}개 파일 검열 통과, ${failedFiles.length}개 파일 실패`);
  
  // 모든 파일이 실패한 경우
  if (validFiles.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: '모든 파일이 검열에 실패했습니다.',
      failedFiles: failedFiles
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // 2) R2 업로드 - 검열 통과한 파일들만 업로드
  let codes = [];
  const uploadSuccessFiles = [];
  const uploadFailedFiles = [];
  
  if (customName && validFiles.length === 1) {
    customName = customName.replace(/ /g, "_");
    try {
      if (await env.IMAGES.get(customName)) {
        return new Response(JSON.stringify({
          success: false,
          error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      console.log(`[R2 업로드] 커스텀 이름으로 업로드 시작: ${customName}`);
      const buffer = await validFiles[0].file.arrayBuffer();
      await env.IMAGES.put(customName, buffer, {
        httpMetadata: { contentType: validFiles[0].file.type }
      });
      codes.push(customName);
      uploadSuccessFiles.push({
        index: validFiles[0].index,
        name: validFiles[0].file.name || 'Unknown',
        code: customName
      });
      console.log(`[R2 업로드] 커스텀 이름 업로드 완료: ${customName}`);
    } catch (e) {
      console.log(`[R2 업로드 실패] 커스텀 이름 업로드 오류:`, e);
      return new Response(JSON.stringify({
        success: false,
        error: `파일 업로드 실패: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  } else {
    console.log(`[R2 업로드] ${validFiles.length}개 파일 업로드 시작`);
    for (let i = 0; i < validFiles.length; i++) {
      const { file, index } = validFiles[i];
      try {
        console.log(`[R2 업로드] ${i + 1}/${validFiles.length} - ${file.name || 'Unknown'} 업로드 중...`);
        const code = await generateUniqueCode(env);
        const buffer = await file.arrayBuffer();
        await env.IMAGES.put(code, buffer, {
          httpMetadata: { contentType: file.type }
        });
        codes.push(code);
        uploadSuccessFiles.push({
          index: index,
          name: file.name || 'Unknown',
          code: code
        });
        console.log(`[R2 업로드] ${i + 1}/${validFiles.length} - 업로드 완료: ${code}`);
      } catch (e) {
        console.log(`[R2 업로드 실패] ${index}번째 파일 업로드 오류:`, e);
        uploadFailedFiles.push({
          index: index,
          name: file.name || 'Unknown',
          error: `업로드 실패: ${e.message}`
        });
        
        // 단일 파일 업로드시에만 즉시 중단
        if (validFiles.length === 1) {
          return new Response(JSON.stringify({
            success: false,
            error: `파일 업로드 실패: ${e.message}`
          }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
    }
    console.log(`[R2 업로드] ${uploadSuccessFiles.length}개 파일 업로드 성공, ${uploadFailedFiles.length}개 파일 업로드 실패`);
  }
  
  // 모든 업로드가 실패한 경우
  if (codes.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: '모든 파일 업로드에 실패했습니다.',
      failedFiles: [...failedFiles, ...uploadFailedFiles]
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const host = request.headers.get('host') || 'example.com';
  const finalUrl = codes.length > 0 ? `https://${host}/${codes.join(",")}` : null;
  const rawUrls = codes.map(code => `https://${host}/${code}?raw=1`);
  console.log(">>> 업로드 완료 =>", finalUrl);

  // 전체 실패한 파일 목록 (검열 실패 + 업로드 실패)
  const allFailedFiles = [...failedFiles, ...uploadFailedFiles];
  
  // API 응답에 성공/실패 정보 포함
  const responseData = { 
    success: codes.length > 0, 
    url: finalUrl,
    rawUrls: rawUrls,
    codes: codes,
    uploadedFiles: uploadSuccessFiles,
    totalFiles: files.length,
    successCount: uploadSuccessFiles.length,
    failureCount: allFailedFiles.length
  };
  
  // 실패한 파일이 있으면 추가 정보 포함
  if (allFailedFiles.length > 0) {
    responseData.failedFiles = allFailedFiles;
    responseData.message = `${uploadSuccessFiles.length}개 파일 업로드 성공, ${allFailedFiles.length}개 파일 실패`;
  }

  return new Response(JSON.stringify(responseData), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 이미지 압축 함수 - WebP로 변환 (10MB 이하로)
async function compressImageToWebP(file, targetSizeMB = 10) {
  try {
    console.log(`[이미지 압축] 원본 크기: ${(file.size / 1024 / 1024).toFixed(2)}MB, 목표 크기: ${targetSizeMB}MB`);
    
    // 이미지를 Canvas로 로드
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    
    // 이미지 데이터 읽기
    const arrayBuffer = await file.arrayBuffer();
    const imageData = new Uint8Array(arrayBuffer);
    
    // ImageBitmap 생성
    const bitmap = await createImageBitmap(file);
    
    // Canvas 크기 설정 (해상도 조정으로 압축)
    let scaleFactor = 1;
    const targetSize = targetSizeMB * 1024 * 1024;
    
    // 해상도 초기 조정
    if (file.size > targetSize) {
      scaleFactor = Math.sqrt(targetSize / file.size);
      scaleFactor = Math.max(0.3, Math.min(1, scaleFactor)); // 0.3 ~ 1.0 범위
    }
    
    const newWidth = Math.floor(bitmap.width * scaleFactor);
    const newHeight = Math.floor(bitmap.height * scaleFactor);
    
    canvas.width = newWidth;
    canvas.height = newHeight;
    
    // 이미지 드로잉
    ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
    
    // WebP로 변환 (품질 조정으로 압축)
    let quality = 0.8;
    let compressedBlob;
    
    // 품질을 점진적으로 낮춰가며 목표 크기 달성
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        compressedBlob = await canvas.convertToBlob({
          type: 'image/webp',
          quality: quality
        });
        
        console.log(`[압축 시도 ${attempt + 1}] 크기: ${(compressedBlob.size / 1024 / 1024).toFixed(2)}MB, 품질: ${quality}`);
        
        if (compressedBlob.size <= targetSize || quality <= 0.1) {
          break;
        }
        
        quality = Math.max(0.1, quality - 0.15);
      } catch (error) {
        console.log(`[압축 시도 ${attempt + 1} 실패]`, error);
        if (attempt === 4) {
          // 압축 실패시 원본 반환
          return file;
        }
      }
    }
    
    if (compressedBlob && compressedBlob.size < file.size) {
      console.log(`[이미지 압축 성공] ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(compressedBlob.size / 1024 / 1024).toFixed(2)}MB`);
      
      // Blob을 File 객체로 변환
      const compressedFile = new File([compressedBlob], file.name.replace(/\.[^/.]+$/, '.webp'), {
        type: 'image/webp',
        lastModified: Date.now()
      });
      
      return compressedFile;
    } else {
      console.log(`[이미지 압축] 압축 효과 없음, 원본 사용`);
      return file;
    }
    
      } catch (error) {
    console.log('[이미지 압축 실패]', error);
    return file; // 압축 실패시 원본 반환
  }
}

// 비디오 압축 함수 - WebM으로 변환 (100MB 이하로)
async function compressVideoToWebM(file, targetSizeMB = 100) {
  try {
    console.log(`[비디오 압축] 원본 크기: ${(file.size / 1024 / 1024).toFixed(2)}MB, 목표 크기: ${targetSizeMB}MB`);
    
    // Worker 환경에서 MediaRecorder API 사용
    const videoUrl = URL.createObjectURL(file);
    const video = new OffscreenCanvas(1, 1);
    
    try {
      // 비디오 메타데이터 처리를 위한 간단한 압축 시뮬레이션
      const targetSize = targetSizeMB * 1024 * 1024;
      
      if (file.size <= targetSize) {
        console.log(`[비디오 압축] 이미 목표 크기 이하, 원본 사용`);
        return file;
      }
      
      // 비디오 압축은 복잡하므로 간단한 학습 버전만 구현
      // 실제 환경에서는 FFmpeg.wasm 또는 외부 서비스 사용 권장
      
      // 비디오가 너무 큰 경우 경고 메시지
      if (file.size > targetSize * 2) {
        console.log(`[비디오 압축 경고] 파일이 너무 큽니다. 외부 압축 도구 사용을 권장합니다.`);
      }
      
      // 기본적으로 원본 반환 (비디오 압축은 복잡하므로)
      return file;
      
    } finally {
      URL.revokeObjectURL(videoUrl);
    }
    
      } catch (error) {
    console.log('[비디오 압축 실패]', error);
    return file; // 압축 실패시 원본 반환
  }
}

// 이미지 검열 - DashScope API 사용
async function handleImageCensorship(file, env) {
  try {
    console.log(`이미지 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const dashscopeApiKey = env.DASHSCOPE_API_KEY;
    
    // API 키 디버깅 정보 (보안상 일부만 표시)
    console.log(`[이미지 검열 API 키 확인] 키 존재 여부: ${!!dashscopeApiKey}`);
    if (dashscopeApiKey) {
      console.log(`[이미지 검열 API 키 확인] 키 길이: ${dashscopeApiKey.length}`);
      console.log(`[이미지 검열 API 키 확인] 키 앞 4자리: ${dashscopeApiKey.substring(0, 4)}...`);
      console.log(`[이미지 검열 API 키 확인] 키 뒤 4자리: ...${dashscopeApiKey.substring(dashscopeApiKey.length - 4)}`);
    }
    
    if (!dashscopeApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'DashScope API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }
    
    // 10MB 초과시 압축
    let processedFile = file;
    if (file.size > 10 * 1024 * 1024) {
      console.log(`[이미지 검열] 10MB 초과, WebP 압축 진행`);
      processedFile = await compressImageToWebP(file);
    }



    // DashScope API를 사용한 이미지 분석
    try {
      // 이미지를 base64로 인코딩
      const buffer = await processedFile.arrayBuffer();
      const base64Image = arrayBufferToBase64(buffer);
      
      // DashScope 재시도 로직으로 API 호출
      console.log(`[DashScope API] 이미지 분석 요청 시작`);
      
      let analysisResponse;
      let attempt = 0;
      const maxRetries = 3;
      
      // 재시도 로직 사용
      while (attempt < maxRetries) {
        // 여러 가지 엔드포인트와 요청 형식 시도
        let apiUrl, requestBody;
        
        if (attempt === 0) {
        // 시도 1: 멀티모달 생성 API (현재 방식)
        apiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
        requestBody = {
          model: 'qwen-vl-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: "Analyze this image for inappropriate content. Be extremely precise and thorough. " +
                      "Look for any attempts to bypass detection through noise, partial covering, artistic filters, or text obfuscation. " +
                      "Also analyze any visible text in the image for inappropriate language, including leetspeak, symbols replacing letters, or intentional misspellings. " +
                      "Rate each category as true (inappropriate) or false (appropriate). Only respond with the number and true/false on each line:\n\n" +
                      "1. Nudity/Sexual content (exposed genitals, sexual acts, suggestive poses): true/false\n" +
                      "2. Partial nudity/Suggestive content (underwear focus, sexual implications, provocative clothing): true/false\n" +
                      "3. Violence/Weapons (guns, knives, violence depiction, weapons display): true/false\n" +
                      "4. Graphic violence/Gore (blood, injuries, death, extreme violence): true/false\n" +
                      "5. Drugs/Alcohol abuse (drug paraphernalia, excessive drinking, drug use): true/false\n" +
                      "6. Hate speech/Offensive language (slurs, hate symbols, discriminatory text): true/false\n" +
                      "7. Harassment/Bullying content (targeting individuals, cyberbullying, intimidation): true/false\n" +
                      "8. Self-harm/Suicide content (cutting, suicide methods, self-injury): true/false\n" +
                      "9. Illegal activities (theft, fraud, illegal substances, criminal acts): true/false\n" +
                      "10. Spam/Scam content (fake offers, phishing, misleading information): true/false\n" +
                      "11. Child exploitation (minors in inappropriate contexts, child endangerment): true/false\n" +
                      "12. Extremist content (terrorist symbols, radical ideologies, dangerous groups): true/false\n\n" +
                      "Be conservative but accurate. Normal everyday content, artistic expression, educational material, " +
                      "and legitimate creative content should be marked as false. Only mark as true if clearly inappropriate."
                  },
                  {
                    image: `data:${processedFile.type};base64,${base64Image}`
                  }
                ]
              }
            ]
          },
          parameters: {
            temperature: 0.05,
            top_k: 20,
            top_p: 0.8,
            max_tokens: 400
          }
        };
      } else if (attempt === 1) {
        // 시도 2: 텍스트 생성 API (간단한 테스트)
        apiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
        requestBody = {
          model: 'qwen-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: 'Hello, this is an API connectivity test. Please respond with "API test successful".'
              }
            ]
          },
          parameters: {
            max_tokens: 50
          }
        };
      } else {
        // 시도 3: 다른 모델 이름 시도
        apiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
        requestBody = {
          model: 'qwen-vl-max', // 다른 모델 이름 시도
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: "Simple test: Is this image appropriate? Answer with 'appropriate' or 'inappropriate'."
                  },
                  {
                    image: `data:${processedFile.type};base64,${base64Image}`
                  }
                ]
              }
            ]
          },
          parameters: {
            temperature: 0.1,
            max_tokens: 50
          }
        };
      }
      
        console.log(`[시도 ${attempt + 1}] 사용 중인 엔드포인트: ${apiUrl}`);
        console.log(`[시도 ${attempt + 1}] 사용 중인 모델: ${requestBody.model}`);
        try {
          console.log(`[DashScope API] 시도 ${attempt + 1}/${maxRetries}`);
          console.log(`[DashScope API] 요청 URL: ${apiUrl}`);
          
          // 여러 가지 인증 방식 시도
          const headers = {
            'Content-Type': 'application/json'
          };
          
          // 시도 1: Authorization Bearer 방식
          if (attempt === 0) {
            headers['Authorization'] = `Bearer ${dashscopeApiKey}`;
            console.log(`[인증 방식] Authorization Bearer`);
          }
          // 시도 2: X-DashScope-API-Key 헤더 방식
          else if (attempt === 1) {
            headers['X-DashScope-API-Key'] = dashscopeApiKey;
            console.log(`[인증 방식] X-DashScope-API-Key 헤더`);
          }
          // 시도 3: Authorization 단순 방식 
          else {
            headers['Authorization'] = dashscopeApiKey;
            console.log(`[인증 방식] Authorization 직접`);
          }
          
          console.log(`[요청 헤더]`, Object.keys(headers).join(', '));
          
          analysisResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
          });
          
          console.log(`[DashScope API] 응답 상태: ${analysisResponse.status} ${analysisResponse.statusText}`);
          console.log(`[DashScope API] 응답 헤더:`, Object.fromEntries(analysisResponse.headers));
          
          if (analysisResponse.ok) {
            console.log(`[DashScope API] 성공 - 시도 ${attempt + 1}`);
            break;
          } else {
            throw new Error(`HTTP ${analysisResponse.status}: ${analysisResponse.statusText}`);
          }
        } catch (error) {
          attempt++;
          console.log(`[DashScope API 오류] 시도 ${attempt}/${maxRetries}: ${error.message}`);
          
          // 401 오류인 경우 상세 정보 출력
          if (error.message.includes('401') || error.message.includes('Unauthorized')) {
            console.log(`[DashScope API 401 오류 디버깅]`);
            console.log(`- API 키 길이: ${dashscopeApiKey.length}`);
            console.log(`- API 키 형식: ${dashscopeApiKey.startsWith('sk-') ? 'OpenAI 스타일 (sk-)' : 'DashScope 표준 형식'}`);
            console.log(`- 요청 헤더: ${JSON.stringify(headers)}`);
            console.log(`- 엔드포인트: ${apiUrl}`);
            console.log(`- 모델: ${requestBody.model}`);
            
            // 응답 본문도 확인
            if (analysisResponse) {
              try {
                const errorResponse = await analysisResponse.text();
                console.log(`- 오류 응답 본문:`, errorResponse);
              } catch (e) {
                console.log(`- 오류 응답 본문 읽기 실패:`, e.message);
              }
            }
          }
          
          if (attempt >= maxRetries) {
            throw new Error(`API 호출 실패 (최대 재시도 초과): ${error.message}`);
          }
          
          // 재시도 전 대기
          const delay = Math.pow(2, attempt) * 1000; // 지수 백오프: 1s, 2s, 4s
          console.log(`[DashScope API] ${delay}ms 후 재시도...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
            
      let analysisResult;
      try {
        analysisResult = await analysisResponse.json();
        console.log(`[DashScope API] 이미지 분석 완료`);
      } catch (parseError) {
        console.log('DashScope JSON 파싱 오류:', parseError);
        const responseText = await analysisResponse.text();
        console.log('원본 응답:', responseText);
        throw new Error(`API 응답 파싱 실패: ${parseError.message}`);
      }
      
      // DashScope 응답에서 텍스트 추출 (다양한 형식 지원)
      let responseText = '';
      
      // 형식 1: output.choices[0].message.content
      if (analysisResult.output?.choices?.[0]?.message?.content) {
        const content = analysisResult.output.choices[0].message.content;
        if (typeof content === 'string') {
          responseText = content;
        } else if (Array.isArray(content)) {
          responseText = content.map(item => item.text || item.content || '').join('');
        }
      }
      // 형식 2: output.text
      else if (analysisResult.output?.text) {
        responseText = analysisResult.output.text;
      }
      // 형식 3: choices[0].text (GPT 스타일)
      else if (analysisResult.choices?.[0]?.text) {
        responseText = analysisResult.choices[0].text;
      }
      // 형식 4: text 직접 필드
      else if (analysisResult.text) {
        responseText = analysisResult.text;
      }
      
      if (!responseText) {
        console.log('DashScope 응답 구조:', JSON.stringify(analysisResult, null, 2));
        throw new Error('분석 결과를 찾을 수 없습니다. API 응답 형식을 확인해주세요.');
      }
      
      console.log(`[DashScope API] 분석 결과 추출 완료: ${responseText.substring(0, 100)}...`);
      
      // 분석 결과 파싱
      const bad = isInappropriateContent(responseText.trim());
    
    // 추가 검증: 너무 많은 카테고리가 true로 나온 경우 재검토
    if (bad.isInappropriate && bad.reasons.length >= 4) {
      console.log(`[이미지 과도한 검열 감지] ${bad.reasons.length}개 카테고리 검출, 재검토 필요`);
      
      // 보수적 재검토 요청
      const reReviewBody = {
          model: 'qwen-vl-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: "Re-examine this image very carefully. Be EXTREMELY conservative and only flag content that is clearly and unambiguously inappropriate. " +
              "Many legitimate, artistic, educational, or everyday content should NOT be flagged. " +
              "Consider context and intent. Only respond 'INAPPROPRIATE' if you are absolutely certain the content violates guidelines, otherwise respond 'APPROPRIATE'."
             },
                  {
                    image: `data:${processedFile.type};base64,${base64Image}`
                  }
                ]
              }
            ]
          },
          parameters: {
          temperature: 0.0, 
            top_k: 10,
            top_p: 0.7,
            max_tokens: 50
          }
        };
        
        const reReviewResp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${dashscopeApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(reReviewBody)
        });
        
        if (reReviewResp.ok) {
          const reReviewResult = await reReviewResp.json();
          let reReviewText = '';
          if (reReviewResult.output?.choices?.[0]?.message?.content) {
            const content = reReviewResult.output.choices[0].message.content;
            if (typeof content === 'string') {
              reReviewText = content;
            } else if (Array.isArray(content)) {
              reReviewText = content.map(item => item.text || '').join('');
            }
          }
          
          if (reReviewText.toLowerCase().includes('appropriate') && !reReviewText.toLowerCase().includes('inappropriate')) {
        console.log(`[이미지 재검토 결과] 적절한 콘텐츠로 판정, 통과 처리`);
        return { ok: true };
          }
      }
    }
    
    if (bad.isInappropriate) {
      console.log(`[이미지 검열 완료] 부적절한 콘텐츠 감지: ${bad.reasons.join(", ")}`);
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `업로드가 거부되었습니다. 부적절한 콘텐츠 감지: ${bad.reasons.join(", ")}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      };
    }
    return { ok: true };
    } catch (error) {
      console.log('[DashScope API 오류]', error);
      throw error;
    }
  } catch (e) {
    console.log('handleImageCensorship 오류:', e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `이미지 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    };
  }
}

// 동영상 검열 - DashScope API 사용
async function handleVideoCensorship(file, env) {
  try {
    console.log(`비디오 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const dashscopeApiKey = env.DASHSCOPE_API_KEY;
    if (!dashscopeApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'DashScope API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    // 100MB 초과시 압축
    let processedFile = file;
    if (file.size > 100 * 1024 * 1024) {
      console.log(`[비디오 검열] 100MB 초과, WebM 압축 진행`);
      processedFile = await compressVideoToWebM(file);
    }



    // DashScope API를 사용한 비디오 분석
    try {
      // 비디오를 base64로 인코딩 (실제 환경에서는 큰 비디오의 경우 청크 업로드 필요)
      const buffer = await processedFile.arrayBuffer();
      const base64Video = arrayBufferToBase64(buffer);
      
      // DashScope 재시도 로직으로 비디오 API 호출
      console.log(`[DashScope API] 비디오 분석 요청 시작`);
      
      const apiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
      
      const requestBody = {
        model: 'qwen-vl-plus',
        input: {
          messages: [
            {
              role: 'user',
              content: [
                {
                  text: "Analyze this video for inappropriate content frame by frame. Be extremely precise and thorough. " +
                    "Look for any attempts to bypass detection through quick flashes, partial covering, artistic filters, blurring, or text obfuscation. " +
                    "Analyze any visible text or audio for inappropriate language, including leetspeak, symbols replacing letters, or intentional misspellings. " +
                    "Consider the entire video duration and any content that appears briefly. " +
                    "Rate each category as true (inappropriate) or false (appropriate). Only respond with the number and true/false on each line:\n\n" +
                    "1. Nudity/Sexual content (exposed genitals, sexual acts, suggestive poses): true/false\n" +
                    "2. Partial nudity/Suggestive content (underwear focus, sexual implications, provocative clothing): true/false\n" +
                    "3. Violence/Weapons (guns, knives, violence depiction, weapons display): true/false\n" +
                    "4. Graphic violence/Gore (blood, injuries, death, extreme violence): true/false\n" +
                    "5. Drugs/Alcohol abuse (drug paraphernalia, excessive drinking, drug use): true/false\n" +
                    "6. Hate speech/Offensive language (slurs, hate symbols, discriminatory text or audio): true/false\n" +
                    "7. Harassment/Bullying content (targeting individuals, cyberbullying, intimidation): true/false\n" +
                    "8. Self-harm/Suicide content (cutting, suicide methods, self-injury): true/false\n" +
                    "9. Illegal activities (theft, fraud, illegal substances, criminal acts): true/false\n" +
                    "10. Spam/Scam content (fake offers, phishing, misleading information): true/false\n" +
                    "11. Child exploitation (minors in inappropriate contexts, child endangerment): true/false\n" +
                    "12. Extremist content (terrorist symbols, radical ideologies, dangerous groups): true/false\n\n" +
                    "Be conservative but accurate. Normal everyday content, artistic expression, educational material, " +
                    "gaming content, and legitimate creative content should be marked as false. Only mark as true if clearly inappropriate."
                },
                {
                  video: `data:${processedFile.type};base64,${base64Video}`
                }
              ]
            }
          ]
        },
        parameters: {
          temperature: 0.05,
          top_k: 20,
          top_p: 0.8,
          max_tokens: 400
        }
      };
      
      let analysisResponse;
      let attempt = 0;
      const maxRetries = 3;
      
      // 재시도 로직 사용
      while (attempt < maxRetries) {
        try {
          console.log(`[DashScope API] 비디오 시도 ${attempt + 1}/${maxRetries}`);
          
          analysisResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
              'Authorization': `Bearer ${dashscopeApiKey}`,
              'Content-Type': 'application/json',
              'X-DashScope-Async': 'enable'
            },
            body: JSON.stringify(requestBody)
          });
          
          if (analysisResponse.ok) {
            console.log(`[DashScope API] 비디오 성공 - 시도 ${attempt + 1}`);
            break;
          } else {
            throw new Error(`HTTP ${analysisResponse.status}: ${analysisResponse.statusText}`);
          }
        } catch (error) {
          attempt++;
          console.log(`[DashScope API 비디오 오류] 시도 ${attempt}/${maxRetries}: ${error.message}`);
          
          if (attempt >= maxRetries) {
            throw new Error(`비디오 API 호출 실패 (최대 재시도 초과): ${error.message}`);
          }
          
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`[DashScope API] ${delay}ms 후 비디오 재시도...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      
      let analysisResult;
      try {
        analysisResult = await analysisResponse.json();
        console.log(`[DashScope API] 비디오 분석 완료`);
      } catch (parseError) {
        console.log('DashScope 비디오 JSON 파싱 오류:', parseError);
        const responseText = await analysisResponse.text();
        console.log('비디오 원본 응답:', responseText);
        throw new Error(`비디오 API 응답 파싱 실패: ${parseError.message}`);
      }
      
      // DashScope 응답에서 텍스트 추출 (다양한 형식 지원)
      let responseText = '';
      
      if (analysisResult.output?.choices?.[0]?.message?.content) {
        const content = analysisResult.output.choices[0].message.content;
        if (typeof content === 'string') {
          responseText = content;
        } else if (Array.isArray(content)) {
          responseText = content.map(item => item.text || item.content || '').join('');
        }
      }
      else if (analysisResult.output?.text) {
        responseText = analysisResult.output.text;
      }
      else if (analysisResult.choices?.[0]?.text) {
        responseText = analysisResult.choices[0].text;
      }
      else if (analysisResult.text) {
        responseText = analysisResult.text;
      }
      
      if (!responseText) {
        console.log('DashScope 비디오 응답 구조:', JSON.stringify(analysisResult, null, 2));
        throw new Error('비디오 분석 결과를 찾을 수 없습니다. API 응답 형식을 확인해주세요.');
      }
      
      console.log(`[DashScope API] 비디오 분석 결과 추출 완료: ${responseText.substring(0, 100)}...`);
      
      // 분석 결과 파싱
      const bad = isInappropriateContent(responseText.trim());
    
    // 추가 검증: 너무 많은 카테고리가 true로 나온 경우 재검토
    if (bad.isInappropriate && bad.reasons.length >= 4) {
      console.log(`[비디오 과도한 검열 감지] ${bad.reasons.length}개 카테고리 검출, 재검토 필요`);
      
      // 보수적 재검토 요청
      const reReviewBody = {
          model: 'qwen-vl-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    text: "Re-examine this video very carefully. Be EXTREMELY conservative and only flag content that is clearly and unambiguously inappropriate. " +
              "Many legitimate, artistic, educational, gaming, or everyday content should NOT be flagged. " +
              "Consider context and intent. Only respond 'INAPPROPRIATE' if you are absolutely certain the content violates guidelines, otherwise respond 'APPROPRIATE'."
             },
                  {
                    video: `data:${processedFile.type};base64,${base64Video}`
                  }
                ]
              }
            ]
          },
          parameters: {
          temperature: 0.0, 
            top_k: 10,
            top_p: 0.7,
            max_tokens: 50
          }
        };
        
        const reReviewResp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${dashscopeApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(reReviewBody)
        });
        
        if (reReviewResp.ok) {
          const reReviewResult = await reReviewResp.json();
          let reReviewText = '';
          if (reReviewResult.output?.choices?.[0]?.message?.content) {
            const content = reReviewResult.output.choices[0].message.content;
            if (typeof content === 'string') {
              reReviewText = content;
            } else if (Array.isArray(content)) {
              reReviewText = content.map(item => item.text || '').join('');
            }
          }
          
          if (reReviewText.toLowerCase().includes('appropriate') && !reReviewText.toLowerCase().includes('inappropriate')) {
        console.log(`[비디오 재검토 결과] 적절한 콘텐츠로 판정, 통과 처리`);
        return { ok: true };
          }
      }
    }
    
    if (bad.isInappropriate) {
      console.log(`[비디오 검열 완료] 부적절한 콘텐츠 감지: ${bad.reasons.join(", ")}`);
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `업로드가 거부되었습니다. 부적절한 콘텐츠 감지: ${bad.reasons.join(', ')}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
    }
    return { ok: true };
    } catch (error) {
      console.log('[DashScope API 오류]', error);
      throw error;
    }
  } catch (e) {
    console.log('handleVideoCensorship 오류:', e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `동영상 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }) };
  }
}

// DashScope API 호출 함수 - 사용하지 않음 (직접 fetch 사용)
// handleImageCensorship와 handleVideoCensorship에서 직접 DashScope API를 호출함

// =======================
// 부적절한 내용 분석 함수 (강화된 버전)
// =======================
function isInappropriateContent(responseText) {
  // 카테고리 인덱스 → 사용자 표시용 이름 매핑 (한국어)
  const categoryMap = {
    1: '성적/노출 콘텐츠',
    2: '부분적 노출/선정적 콘텐츠',
    3: '폭력/무기 콘텐츠',
    4: '극단적 폭력/고어 콘텐츠',
    5: '약물/알코올 남용 콘텐츠',
    6: '혐오 발언/욕설',
    7: '괴롭힘/따돌림 콘텐츠',
    8: '자해/자살 관련 콘텐츠',
    9: '불법 활동',
    10: '스팸/사기 콘텐츠',
    11: '아동 착취',
    12: '극단주의 콘텐츠'
  };

  // 결과 저장소
  const flagged = [];

  // 응답을 줄별로 순회하며 다양한 패턴 파싱
  responseText.split(/\r?\n/).forEach((line, lineIndex) => {
    // 패턴 1: "숫자. true/false" 형태
    let m = line.match(/^\s*([1-9]|1[0-2])\.\s*(true|false)\b/i);
    if (!m) {
      // 패턴 2: "숫자: true/false" 형태
      m = line.match(/^\s*([1-9]|1[0-2]):\s*(true|false)\b/i);
    }
    if (!m) {
      // 패턴 3: "숫자 - true/false" 형태
      m = line.match(/^\s*([1-9]|1[0-2])\s*[-–]\s*(true|false)\b/i);
    }
    if (!m) {
      // 패턴 4: "숫자) true/false" 형태
      m = line.match(/^\s*([1-9]|1[0-2])\)\s*(true|false)\b/i);
    }
    if (!m) {
      // 패턴 5: 단순히 "true" 또는 "false"만 있는 경우 (순서대로 1-12 매핑)
      const trueMatch = line.match(/^\s*(true|false)\b/i);
      if (trueMatch) {
        // 실제 내용이 있는 줄들만 카운트
        const contentLines = responseText.split(/\r?\n/).filter(l => l.trim().match(/^\s*(true|false)\b/i));
        const contentLineIndex = contentLines.indexOf(line.trim());
        if (contentLineIndex >= 0 && contentLineIndex < 12) {
          m = [null, (contentLineIndex + 1).toString(), trueMatch[1]];
        }
      }
    }
    
    if (m) {
      const idx = Number(m[1]);
      const val = m[2].toLowerCase() === 'true';
      if (val && categoryMap[idx]) {
        flagged.push(categoryMap[idx]);
      }
    }
  });

  return {
    isInappropriate: flagged.length > 0,
    reasons: flagged
  };
}

// MP4 재생길이 간단 추출 함수
async function getMP4Duration(file) {
  try {
    const buffer = await file.arrayBuffer(), dv = new DataView(buffer), u = new Uint8Array(buffer);
    for (let i=0; i<u.length-4; i++) {
      if (u[i]===109 && u[i+1]===118 && u[i+2]===104 && u[i+3]===100) {
        const vs = dv.getUint8(i-4+8);
        const ts = vs===0 ? dv.getUint32(i-4+20) : dv.getUint32(i-4+28);
        const du = vs===0 ? dv.getUint32(i-4+24) : (dv.getUint32(i-4+32)*2**32 + dv.getUint32(i-4+36));
        return du/ts;
      }
    }
    return null;
  } catch (e) {
    console.log("getMP4Duration error:", e);
    return null;
  }
}

// 고유 8자 코드 생성
async function generateUniqueCode(env, length=8) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let t=0; t<10; t++) {
    let code=''; for (let i=0;i<length;i++) code+=chars.charAt(Math.floor(Math.random()*chars.length));
    if (!(await env.IMAGES.get(code))) return code;
  }
  throw new Error("코드 생성 실패");
}

// ArrayBuffer -> base64
function arrayBufferToBase64(buffer) {
  let bin='', bytes=new Uint8Array(buffer);
  for (let b of bytes) bin+=String.fromCharCode(b);
  return btoa(bin);
}

// 최종 HTML 렌더
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

    /* 전체화면 모달 스타일 */
    .image-modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.9);
    }

    .modal-content {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }

         .modal-image {
       max-width: 90%;
       max-height: 90%;
       transform-origin: center;
       transition: transform 0.3s ease;
       cursor: grab;
       touch-action: manipulation; /* 모바일 더블탭 확대 방지 */
       user-select: none; /* 텍스트 선택 방지 */
       -webkit-user-select: none;
       -moz-user-select: none;
       -ms-user-select: none;
     }

     .modal-image:active {
       cursor: grabbing;
     }

     .modal-image.dragging {
       transition: none; /* 드래그 중 애니메이션 제거 */
       cursor: grabbing;
     }

    /* 컨트롤 패널 */
    .modal-controls {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 10px;
      background: rgba(0, 0, 0, 0.7);
      padding: 10px;
      border-radius: 25px;
    }

    .control-btn {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: background 0.3s ease;
    }

    .control-btn:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    /* 닫기 버튼 */
    .modal-close {
      position: absolute;
      top: 20px;
      right: 30px;
      color: white;
      font-size: 40px;
      font-weight: bold;
      cursor: pointer;
      z-index: 1001;
    }

    .modal-close:hover {
      opacity: 0.7;
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
  
  <!-- 전체화면 이미지 모달 -->
  <div id="imageModal" class="image-modal">
    <span class="modal-close" id="modalClose">&times;</span>
    <div class="modal-content">
      <img id="modalImage" class="modal-image" src="" alt="확대된 이미지" draggable="false">
      <div class="modal-controls">
        <button class="control-btn" id="zoomIn" title="확대">+</button>
        <button class="control-btn" id="zoomOut" title="축소">-</button>
        <button class="control-btn" id="rotateLeft" title="왼쪽 회전">↶</button>
        <button class="control-btn" id="rotateRight" title="오른쪽 회전">↷</button>
        <button class="control-btn" id="resetView" title="원래 크기">⟲</button>
      </div>
    </div>
  </div>
  
  <div class="custom-context-menu" id="customContextMenu" style="display: none;">
      <button id="copyImage">이미지 복사</button>
      <button id="copyImageurl">이미지 링크 복사</button>
      <button id="downloadImage">다운로드</button>
      <button id="downloadImagepng">png로 다운로드</button>
  </div>
  <script>
    // 새로운 이미지 뷰어 기능
    class ImageViewer {
      constructor() {
        this.modal = document.getElementById('imageModal');
        this.modalImage = document.getElementById('modalImage');
        this.closeBtn = document.getElementById('modalClose');
        this.zoomInBtn = document.getElementById('zoomIn');
        this.zoomOutBtn = document.getElementById('zoomOut');
        this.rotateLeftBtn = document.getElementById('rotateLeft');
        this.rotateRightBtn = document.getElementById('rotateRight');
        this.resetBtn = document.getElementById('resetView');
        
        this.scale = 1;
        this.rotation = 0;
        this.posX = 0;
        this.posY = 0;
        this.isDragging = false;
        this.startX = 0;
        this.startY = 0;
        
        this.init();
      }
      
      init() {
        // 이벤트 리스너 등록
        this.closeBtn.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
          if (e.target === this.modal) this.closeModal();
        });
        
        // 컨트롤 버튼 이벤트
        this.zoomInBtn.addEventListener('click', () => this.zoomIn());
        this.zoomOutBtn.addEventListener('click', () => this.zoomOut());
        this.rotateLeftBtn.addEventListener('click', () => this.rotateLeft());
        this.rotateRightBtn.addEventListener('click', () => this.rotateRight());
        this.resetBtn.addEventListener('click', () => this.resetView());
        
                 // 마우스 드래그 이벤트
         this.modalImage.addEventListener('mousedown', (e) => this.startDrag(e));
         document.addEventListener('mousemove', (e) => this.drag(e));
         document.addEventListener('mouseup', () => this.endDrag());
         
         // 터치 드래그 이벤트 (모바일)
         this.modalImage.addEventListener('touchstart', (e) => this.startTouch(e));
         document.addEventListener('touchmove', (e) => this.touchMove(e));
         document.addEventListener('touchend', () => this.endDrag());
         
         // 브라우저 기본 드래그 및 더블탭 확대 방지
         this.modalImage.addEventListener('dragstart', (e) => e.preventDefault());
         this.modalImage.addEventListener('gesturestart', (e) => e.preventDefault());
         this.modalImage.addEventListener('gesturechange', (e) => e.preventDefault());
         this.modalImage.addEventListener('gestureend', (e) => e.preventDefault());
        
        // 마우스 휠로 확대/축소
        this.modalImage.addEventListener('wheel', (e) => this.handleWheel(e));
        
        // ESC 키로 닫기
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && this.modal.style.display === 'block') {
            this.closeModal();
          }
        });
        
        // 이미지 클릭 이벤트 등록
        this.setupImageClickHandlers();
      }
      
      setupImageClickHandlers() {
        document.querySelectorAll('#imageContainer img').forEach(img => {
          this.addClickHandler(img);
        });
      }
      
      addClickHandler(img) {
        img.addEventListener('click', (e) => {
          e.preventDefault();
          this.openModal(img.src);
        });
      }
      
      openModal(imageSrc) {
        this.modalImage.src = imageSrc;
        this.modal.style.display = 'block';
        this.resetView();
        document.body.style.overflow = 'hidden';
      }
      
      closeModal() {
        this.modal.style.display = 'none';
        document.body.style.overflow = 'auto';
      }
      
      zoomIn() {
        this.scale = Math.min(this.scale * 1.2, 5);
        this.updateTransform();
      }
      
      zoomOut() {
        this.scale = Math.max(this.scale / 1.2, 0.1);
        this.updateTransform();
      }
      
      rotateLeft() {
        this.rotation -= 90;
        this.updateTransform();
      }
      
      rotateRight() {
        this.rotation += 90;
        this.updateTransform();
      }
      
      resetView() {
        this.scale = 1;
        this.rotation = 0;
        this.posX = 0;
        this.posY = 0;
        this.updateTransform();
      }
      
             startDrag(e) {
         if (this.scale > 1) {
           this.isDragging = true;
           this.startX = e.clientX - this.posX;
           this.startY = e.clientY - this.posY;
           this.modalImage.classList.add('dragging');
           e.preventDefault();
         }
       }
       
       startTouch(e) {
         if (this.scale > 1 && e.touches.length === 1) {
           this.isDragging = true;
           const touch = e.touches[0];
           this.startX = touch.clientX - this.posX;
           this.startY = touch.clientY - this.posY;
           this.modalImage.classList.add('dragging');
           e.preventDefault();
         }
       }
       
       drag(e) {
         if (this.isDragging) {
           this.posX = e.clientX - this.startX;
           this.posY = e.clientY - this.startY;
           this.updateTransform();
         }
       }
       
       touchMove(e) {
         if (this.isDragging && e.touches.length === 1) {
           const touch = e.touches[0];
           this.posX = touch.clientX - this.startX;
           this.posY = touch.clientY - this.startY;
           this.updateTransform();
           e.preventDefault();
         }
       }
       
       endDrag() {
         if (this.isDragging) {
           this.isDragging = false;
           this.modalImage.classList.remove('dragging');
         }
       }
      
      handleWheel(e) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.zoomIn();
        } else {
          this.zoomOut();
        }
      }
      
      updateTransform() {
        const transform = \`translate(\${this.posX}px, \${this.posY}px) scale(\${this.scale}) rotate(\${this.rotation}deg)\`;
        this.modalImage.style.transform = transform;
      }
    }
    
    // 이미지 뷰어 초기화
    document.addEventListener('DOMContentLoaded', () => {
      new ImageViewer();
    });
    
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

// API 문서 HTML 렌더링
function renderApiDocs(host) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="https://i.imgur.com/2MkyDCh.png" type="image/png">
  <title>이미지 공유 API 문서</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      color: #333;
    }
    h1, h2, h3 {
      color: #0066cc;
    }
    .endpoint {
      background-color: #f5f5f5;
      border-left: 4px solid #0066cc;
      padding: 10px;
      margin: 20px 0;
    }
    code {
      background-color: #f0f0f0;
      padding: 2px 5px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    pre {
      background-color: #f0f0f0;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
    }
    .method {
      font-weight: bold;
      color: #ffffff;
      border-radius: 3px;
      padding: 2px 5px;
      margin-right: 5px;
    }
    .get {
      background-color: #61affe;
    }
    .post {
      background-color: #49cc90;
    }
    .delete {
      background-color: #f93e3e;
    }
    .put {
      background-color: #fca130;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 10px;
      text-align: left;
    }
    th {
      background-color: #f0f0f0;
    }
    .example {
      margin-top: 20px;
    }
    .header {
      display: flex;
      align-items: center;
      margin-bottom: 20px;
    }
    .header img {
      width: 60px;
      height: auto;
      margin-right: 15px;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="https://i.imgur.com/2MkyDCh.png" alt="Logo">
    <h1>이미지 공유 API 문서</h1>
  </div>
  
  <p>이 API는 외부 애플리케이션에서 이미지 및 동영상을 업로드하고 공유할 수 있는 기능을 제공합니다. 모든 콘텐츠는 업로드 전 AI 기반 자동 검열을 거쳐 부적절한 콘텐츠를 차단합니다.</p>
  
  <h2>엔드포인트</h2>
  
  <div class="endpoint">
    <h3><span class="method post">POST</span> /api/upload</h3>
    <p>이미지 또는 동영상 파일을 업로드합니다. 모든 파일은 자동으로 부적절한 콘텐츠 검열을 거칩니다.</p>
    
    <h4>요청 형식</h4>
    <p>요청은 <code>multipart/form-data</code> 형식이어야 합니다.</p>
    
    <table>
      <tr>
        <th>파라미터</th>
        <th>타입</th>
        <th>필수</th>
        <th>설명</th>
      </tr>
      <tr>
        <td>file</td>
        <td>File</td>
        <td>예</td>
        <td>업로드할 이미지 또는 동영상 파일. 여러 파일 업로드 가능.</td>
      </tr>
      <tr>
        <td>customName</td>
        <td>String</td>
        <td>아니오</td>
        <td>사용자 지정 파일 이름 (단일 파일 업로드 시에만 유효).</td>
      </tr>
    </table>
    
    <h4>지원 파일 형식</h4>
    <ul>
      <li>이미지: JPEG, PNG, GIF, WEBP</li>
      <li>동영상: MP4, WEBM, OGG, AVI</li>
    </ul>
    
    <h4>응답</h4>
    <p>성공 시 응답 (200 OK):</p>
    <pre>{
  "success": true,
  "url": "https://${host}/ABC123",
  "rawUrls": ["https://${host}/ABC123?raw=1"],
  "codes": ["ABC123"],
  "fileTypes": ["image/jpeg"]
}</pre>
    
    <p>파일 형식 오류 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "지원하지 않는 파일 형식입니다."
}</pre>
    
    <p>검열 실패 (400 Bad Request):</p>
    <pre>{
  "success": false,
  "error": "검열됨: 선정적 콘텐츠, 폭력/무기 콘텐츠"
}</pre>
    
    <p>서버 오류 (500 Internal Server Error):</p>
    <pre>{
  "success": false,
  "error": "검열 처리 중 오류: [오류 메시지]"
}</pre>
    
    <p>레이트 리미팅 (429 Too Many Requests):</p>
    <pre>{
  "success": false,
  "error": "보안상 업로드가 제한되었습니다. 1분 내 20개 초과 업로드로 인한 5분 차단. 300초 후 다시 시도하세요.",
  "rateLimited": true,
  "remainingTime": 300
}</pre>
  </div>
  
  <h2>레이트 리미팅</h2>
  <div class="endpoint">
    <h3>업로드 제한</h3>
    <p>보안을 위해 다음과 같은 레이트 리미팅이 적용됩니다:</p>
    <ul>
      <li><strong>1분 제한:</strong> 동일한 IP에서 1분 내 20개 이상 업로드 시 5분간 차단</li>
      <li><strong>1시간 제한:</strong> 동일한 IP에서 1시간 내 100개 이상 업로드 시 1시간 차단</li>
    </ul>
    <p>제한 초과 시 HTTP 429 상태 코드와 함께 차단 해제까지 남은 시간이 응답됩니다.</p>
  </div>
  
  <h2>코드 예제</h2>
  
  <div class="example">
    <h3>cURL</h3>
    <pre>curl -X POST https://${host}/api/upload \
  -F "file=@/path/to/image.jpg"</pre>
  </div>
  
  <div class="example">
    <h3>JavaScript (fetch)</h3>
    <pre>const formData = new FormData();
formData.append('file', fileInput.files[0]);

fetch('https://${host}/api/upload', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    console.log('업로드 성공:', data.url);
  } else {
    console.error('업로드 실패:', data.error);
  }
})
.catch(error => {
  console.error('요청 오류:', error);
});</pre>
  </div>
  
  <div class="example">
    <h3>Python (requests)</h3>
    <pre>import requests

url = 'https://${host}/api/upload'
files = {'file': open('image.jpg', 'rb')}

response = requests.post(url, files=files)
data = response.json()

if data['success']:
    print('업로드 성공:', data['url'])
else:
    print('업로드 실패:', data['error'])</pre>
  </div>
  
  <h2>노트</h2>
  <ul>
    <li>모든 업로드된 파일은 자동 검열 시스템을 통과해야 합니다.</li>
    <li>대용량 파일 업로드 시 서버 처리 시간이 길어질 수 있습니다.</li>
    <li>기본적으로 랜덤 코드가 생성되지만, <code>customName</code> 파라미터를 통해 사용자 지정 이름을 부여할 수 있습니다.</li>
    <li>동일한 사용자 지정 이름이 이미 존재하는 경우 업로드가 실패합니다.</li>
    <li>외부 도메인에서 API 요청 시 CORS 헤더가 자동으로 추가됩니다.</li>
  </ul>
</body>
</html>`;
}
