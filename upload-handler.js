// ==============================
// 업로드 처리 관리
// ==============================

import { handleImageCensorship, handleVideoCensorship } from './censorship.js';
import { generateUniqueCode } from './utils.js';

/**
 * 메인 업로드 처리 함수
 * @param {Request} request - 요청 객체
 * @param {Object} env - 환경 변수
 * @returns {Response} - 응답 객체
 */
export async function handleUpload(request, env, ctx) {
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

  // 병렬 처리: 검열 & R2 업로드
  const uploadSuccessFiles = [];
  const uploadFailedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let r2Key;

    console.log(`[처리 시작] ${i + 1}/${files.length} - ${file.name || 'Unknown'}, ${file.type}, ${(file.size / 1024 / 1024).toFixed(2)}MB`);

    try {
      // 1. R2 키 결정 (커스텀 이름 또는 자동 생성)
      if (customName && files.length === 1) {
        r2Key = customName.replace(/ /g, "_");
        if (await env.IMAGES.get(r2Key)) {
          return new Response(JSON.stringify({
            success: false,
            error: '이미 사용 중인 이름입니다. 다른 이름을 선택해주세요.'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else {
        r2Key = await generateUniqueCode(env);
      }

      // 2. 파일 버퍼 읽기 (한 번만)
      const fileBuffer = await file.arrayBuffer();
      console.log(`[파일 읽기 완료] ${r2Key} - ${(fileBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);

      // 3. 검열과 R2 업로드 병렬 시작
      console.log(`[병렬 작업 시작] ${r2Key} - R2 업로드 & 콘텐츠 검열`);
      const censorshipPromise = file.type.startsWith('image/')
        ? handleImageCensorship(file, fileBuffer, env)
        : handleVideoCensorship(file, fileBuffer, env);

      const r2UploadPromise = env.IMAGES.put(r2Key, fileBuffer, {
        httpMetadata: { contentType: file.type }
      });

      const [censorshipSettled, r2UploadSettled] = await Promise.allSettled([censorshipPromise, r2UploadPromise]);

      // 4. 결과 처리
      if (r2UploadSettled.status === 'rejected') {
        // R2 업로드 실패 시, 심각한 오류로 간주하고 즉시 중단
        console.log(`[R2 업로드 실패!] ${r2Key}`, r2UploadSettled.reason);
        throw r2UploadSettled.reason;
      }
      console.log(`[R2 업로드 성공] ${r2Key}`);

      if (censorshipSettled.status === 'rejected' || !censorshipSettled.value.ok) {
        // 검열 실패 또는 오류 시, 이미 업로드된 R2 파일 백그라운드 삭제
        console.log(`[검열 실패] ${r2Key} - R2에서 파일 삭제 예약`);
        ctx.waitUntil(env.IMAGES.delete(r2Key));

        let errorMessage = '콘텐츠 검열 중 오류가 발생했습니다.';
        if (censorshipSettled.status === 'fulfilled' && !censorshipSettled.value.ok) {
          const errData = await censorshipSettled.value.response.json();
          errorMessage = errData.error || '부적절한 콘텐츠가 감지되었습니다.';
        } else if (censorshipSettled.status === 'rejected') {
          errorMessage = censorshipSettled.reason.message;
        }
        
        const fileInfo = { index: i + 1, name: file.name || 'Unknown', error: errorMessage };
        uploadFailedFiles.push(fileInfo);
        
        if (files.length === 1) {
          return new Response(JSON.stringify({ success: false, error: `파일 검열 실패: ${errorMessage}` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
      } else {
        // 모든 작업 성공
        console.log(`[처리 성공] ${r2Key}`);
        uploadSuccessFiles.push({ index: i + 1, name: file.name || 'Unknown', code: r2Key });
      }
    } catch (e) {
      console.log(`[처리 오류] ${i + 1}번째 파일 처리 중 오류:`, e);
      const fileInfo = { index: i + 1, name: file.name || 'Unknown', error: `업로드 중 오류: ${e.message}` };
      uploadFailedFiles.push(fileInfo);

      if (files.length === 1) {
        return new Response(JSON.stringify({ success: false, error: `파일 업로드 중 오류: ${e.message}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
  }

  // 5. 최종 응답 구성
  console.log(`[처리 완료] 성공: ${uploadSuccessFiles.length}개, 실패: ${uploadFailedFiles.length}개`);

  if (uploadSuccessFiles.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      error: '모든 파일 업로드에 실패했습니다.',
      failedFiles: uploadFailedFiles
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const codes = uploadSuccessFiles.map(f => f.code);
  const host = request.headers.get('host') || 'example.com';
  const finalUrl = codes.length > 0 ? `https://${host}/${codes.join(",")}` : null;
  const rawUrls = codes.map(code => `https://${host}/${code}?raw=1`);
  console.log(">>> 최종 URL =>", finalUrl);

  const responseData = { 
    success: true, 
    url: finalUrl,
    rawUrls: rawUrls,
    codes: codes,
    uploadedFiles: uploadSuccessFiles,
    totalFiles: files.length,
    successCount: uploadSuccessFiles.length,
    failureCount: uploadFailedFiles.length
  };
  
  if (uploadFailedFiles.length > 0) {
    responseData.failedFiles = uploadFailedFiles;
    responseData.message = `${uploadSuccessFiles.length}개 파일 업로드 성공, ${uploadFailedFiles.length}개 파일 실패`;
  }

  return new Response(JSON.stringify(responseData), {
    headers: { 'Content-Type': 'application/json' }
  });
}

