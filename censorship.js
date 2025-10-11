// ==============================
// 콘텐츠 검열 관리
// ==============================

import { arrayBufferToBase64 } from './utils.js';

/**
 * 파일을 IVCP API를 통해 압축
 * @param {ArrayBuffer} fileBuffer - 압축할 파일 버퍼
 * @param {string} fileName - 파일 이름
 * @param {string} fileType - 파일 MIME 타입
 * @param {string} type - 파일 타입 ('image' 또는 'video')
 * @returns {File} - 압축된 파일
 */
async function compressFileForCensorship(fileBuffer, fileName, fileType, type) {
  const IVCP_API_BASE = 'https://ivcp.bloupla.net/api';
  const TARGET_SIZE_KB = 5120; // 5MB in KB
  
  try {
    console.log(`[IVCP 압축] ${type} 압축 시작 - 원본 크기: ${(fileBuffer.byteLength / (1024 * 1024)).toFixed(2)}MB`);
    
    // ArrayBuffer에서 새로운 File 객체 생성
    const fileBlob = new Blob([fileBuffer], { type: fileType });
    const fileForUpload = new File([fileBlob], fileName, { type: fileType });
    
    const formData = new FormData();
    if (type === 'image') {
      formData.append('image', fileForUpload);
      formData.append('targetSizeKB', TARGET_SIZE_KB.toString());
    } else {
      formData.append('video', fileForUpload);
      formData.append('targetSizeKB', TARGET_SIZE_KB.toString());
      formData.append('compressionMode', 'compress');
    }
    
    const endpoint = type === 'image' ? '/compress-image' : '/compress-video';
    const response = await fetch(`${IVCP_API_BASE}${endpoint}`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[IVCP 압축] API 오류 응답: ${errorText}`);
      throw new Error(`IVCP API 오류: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type');
    
    // JSON 응답인 경우 (에러 또는 메타데이터)
    if (contentType && contentType.includes('application/json')) {
      const result = await response.json();
      
      // 이미 목표 크기 이하인 경우
      if (result.alreadySmaller) {
        console.log(`[IVCP 압축] 파일이 이미 목표 크기 이하입니다.`);
        // 원본 버퍼로 새 File 객체 반환
        const blob = new Blob([fileBuffer], { type: fileType });
        return new File([blob], fileName, { type: fileType });
      }
      
      if (!result.success) {
        throw new Error('압축 실패: ' + (result.error || '알 수 없는 오류'));
      }
      
      // Base64 형식인 경우
      if (result.compressedFile) {
        const base64Data = result.compressedFile.split(',')[1] || result.compressedFile;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: fileType });
        const compressedFile = new File([blob], fileName, { type: fileType });
        console.log(`[IVCP 압축] 압축 완료 (Base64) - 압축 후 크기: ${(compressedFile.size / (1024 * 1024)).toFixed(2)}MB`);
        return compressedFile;
      }
    }
    
    // Blob 응답인 경우 (압축된 파일 직접 반환)
    const blob = await response.blob();
    const compressedFile = new File([blob], fileName, { type: fileType });
    
    console.log(`[IVCP 압축] 압축 완료 (Blob) - 압축 후 크기: ${(compressedFile.size / (1024 * 1024)).toFixed(2)}MB`);
    return compressedFile;
  } catch (error) {
    console.log(`[IVCP 압축] 압축 실패: ${error.message}`);
    throw error;
  }
}

/**
 * 이미지 검열 - base64 인코딩 사용
 * @param {File} file - 검열할 이미지 파일
 * @param {ArrayBuffer} fileBuffer - 미리 읽은 파일 버퍼 (성능 최적화)
 * @param {Object} env - 환경 변수
 * @returns {Object} - 검열 결과
 */
export async function handleImageCensorship(file, fileBuffer, env) {
  try {
    console.log(`이미지 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const dashscopeApiKey = env.DASHSCOPE_API_KEY;
    if (!dashscopeApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'DashScope API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    // 5MB 이상인 경우 압축
    const FIVE_MB = 5 * 1024 * 1024;
    let bufferForCensorship = fileBuffer;
    if (file.size > FIVE_MB) {
      console.log(`[이미지 압축] 파일 크기가 5MB를 초과하여 압축 진행`);
      try {
        const compressedFile = await compressFileForCensorship(fileBuffer, file.name, file.type, 'image');
        bufferForCensorship = await compressedFile.arrayBuffer();
        console.log(`[이미지 압축] 압축된 버퍼 크기: ${(bufferForCensorship.byteLength / 1024 / 1024).toFixed(2)}MB`);
      } catch (compressionError) {
        console.log(`[이미지 압축] 압축 실패, 원본 버퍼로 계속 진행: ${compressionError.message}`);
        // 압축 실패 시 원본 버퍼로 계속 진행
      }
    }

    // 이미지를 base64로 인코딩 (미리 읽은 버퍼 사용)
    console.log(`[이미지 인코딩] Base64 변환 시작 (버퍼 크기: ${(bufferForCensorship.byteLength / 1024 / 1024).toFixed(2)}MB)`);
    const base64Image = arrayBufferToBase64(bufferForCensorship);
    console.log(`[이미지 인코딩] 완료 - Base64 길이: ${base64Image.length} 문자`);

    // 검열 요청 - OpenAI 호환 형식
    const requestBody = {
      model: 'qwen3-vl-235b-a22b-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                "Analyze this image for inappropriate content. Be extremely strict and thorough. " +
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
                "Be strict. Mark as true if there is any doubt about appropriateness."
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${file.type};base64,${base64Image}`
              }
            }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 400
    };

    console.log(`[이미지 검열 API 요청] URL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`);
    console.log(`[이미지 검열 API 요청] 모델: ${requestBody.model}`);
    console.log(`[이미지 검열 API 요청] 이미지 타입: ${file.type}`);
    console.log(`[이미지 검열 API 요청] Base64 이미지 URL 길이: ${requestBody.messages[0].content[1].image_url.url.length} 문자`);

    const analysis = await callQwenAPI(dashscopeApiKey, requestBody);
    if (!analysis.success) {
      throw new Error(analysis.error);
    }

    console.log(`[이미지 검열 API 응답] 전체 텍스트:\n${analysis.text}`);
    
    const bad = isInappropriateContent(analysis.text);
    console.log(`[이미지 검열 판단] 부적절 여부: ${bad.isInappropriate}`);
    console.log(`[이미지 검열 판단] 검출된 카테고리 수: ${bad.reasons.length}`);
    if (bad.reasons.length > 0) {
      console.log(`[이미지 검열 판단] 검출된 카테고리: ${bad.reasons.join(", ")}`);
    }
    
    if (bad.isInappropriate) {
      console.log(`[이미지 검열 완료] 부적절한 콘텐츠 감지 - 업로드 거부`);
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `업로드가 거부되었습니다. 부적절한 콘텐츠 감지: ${bad.reasons.join(", ")}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      };
    }
    console.log(`[이미지 검열 완료] 적절한 콘텐츠 - 업로드 허용`);
    return { ok: true };
  } catch (e) {
    console.log('handleImageCensorship 오류:', e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `이미지 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    };
  }
}

/**
 * 동영상 검열 - base64 인코딩 사용
 * @param {File} file - 검열할 동영상 파일
 * @param {ArrayBuffer} fileBuffer - 미리 읽은 파일 버퍼 (성능 최적화)
 * @param {Object} env - 환경 변수
 * @returns {Object} - 검열 결과
 */
export async function handleVideoCensorship(file, fileBuffer, env) {
  try {
    console.log(`비디오 크기: ${(file.size / (1024 * 1024)).toFixed(2)}MB`);
    const dashscopeApiKey = env.DASHSCOPE_API_KEY;
    if (!dashscopeApiKey) {
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: 'DashScope API 키가 설정되지 않았습니다.'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      };
    }

    // 5MB 이상인 경우 압축
    const FIVE_MB = 5 * 1024 * 1024;
    let bufferForCensorship = fileBuffer;
    if (file.size > FIVE_MB) {
      console.log(`[동영상 압축] 파일 크기가 5MB를 초과하여 압축 진행`);
      try {
        const compressedFile = await compressFileForCensorship(fileBuffer, file.name, file.type, 'video');
        bufferForCensorship = await compressedFile.arrayBuffer();
        console.log(`[동영상 압축] 압축된 버퍼 크기: ${(bufferForCensorship.byteLength / 1024 / 1024).toFixed(2)}MB`);
      } catch (compressionError) {
        console.log(`[동영상 압축] 압축 실패, 원본 버퍼로 계속 진행: ${compressionError.message}`);
        // 압축 실패 시 원본 버퍼로 계속 진행
      }
    }

    // 비디오를 base64로 인코딩 (미리 읽은 버퍼 사용)
    console.log(`[동영상 인코딩] Base64 변환 시작 (버퍼 크기: ${(bufferForCensorship.byteLength / 1024 / 1024).toFixed(2)}MB)`);
    const base64Video = arrayBufferToBase64(bufferForCensorship);
    console.log(`[동영상 인코딩] 완료 - Base64 길이: ${base64Video.length} 문자`);

    // 검열 요청 - OpenAI 호환 형식
    const requestBody = {
      model: 'qwen3-vl-235b-a22b-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                "Analyze this video for inappropriate content frame by frame. Be extremely strict and thorough. " +
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
                "Be strict. Mark as true if there is any doubt about appropriateness."
            },
            {
              type: 'video_url',
              video_url: {
                url: `data:${file.type};base64,${base64Video}`
              }
            }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 400
    };
    
    console.log(`[동영상 검열 API 요청] URL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`);
    console.log(`[동영상 검열 API 요청] 모델: ${requestBody.model}`);
    console.log(`[동영상 검열 API 요청] 비디오 타입: ${file.type}`);
    console.log(`[동영상 검열 API 요청] Base64 비디오 URL 길이: ${requestBody.messages[0].content[1].video_url.url.length} 문자`);
    
    const analysis = await callQwenAPI(dashscopeApiKey, requestBody);
    if (!analysis.success) {
      throw new Error(analysis.error);
    }
    
    console.log(`[동영상 검열 API 응답] 전체 텍스트:\n${analysis.text}`);
    
    const bad = isInappropriateContent(analysis.text);
    console.log(`[동영상 검열 판단] 부적절 여부: ${bad.isInappropriate}`);
    console.log(`[동영상 검열 판단] 검출된 카테고리 수: ${bad.reasons.length}`);
    if (bad.reasons.length > 0) {
      console.log(`[동영상 검열 판단] 검출된 카테고리: ${bad.reasons.join(", ")}`);
    }
    
    if (bad.isInappropriate) {
      console.log(`[동영상 검열 완료] 부적절한 콘텐츠 감지 - 업로드 거부`);
      return { ok: false, response: new Response(JSON.stringify({
          success: false, error: `업로드가 거부되었습니다. 부적절한 콘텐츠 감지: ${bad.reasons.join(', ')}`
        }), { status: 400, headers: { 'Content-Type': 'application/json' } }) };
    }
    console.log(`[동영상 검열 완료] 적절한 콘텐츠 - 업로드 허용`);
    return { ok: true };
  } catch (e) {
    console.log('handleVideoCensorship 오류:', e);
    return { ok: false, response: new Response(JSON.stringify({
        success: false, error: `동영상 검열 중 오류 발생: ${e.message}`
      }), { status: 500, headers: { 'Content-Type': 'application/json' } }) };
  }
}

/**
 * Qwen API 호출 함수
 * @param {string} apiKey - API 키
 * @param {Object} requestBody - 요청 본문
 * @returns {Object} - API 응답
 */
async function callQwenAPI(apiKey, requestBody) {
  let retryCount = 0;
  const maxRetries = 3, retryDelay = 2000;
  while (retryCount < maxRetries) {
    try {
      const apiUrl = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
      console.log(`[Qwen API 호출] 시도 ${retryCount + 1}/${maxRetries}`);
      console.log(`[Qwen API 호출] API 키: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log(`[Qwen API 응답] HTTP 상태: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        if (response.status === 429 && retryCount < maxRetries - 1) {
          retryCount++;
          console.log(`[Qwen API] 할당량 초과, 재시도 ${retryCount}/${maxRetries}`);
          await new Promise(r => setTimeout(r, retryDelay));
          continue;
        }
        console.log('[Qwen API 호출 실패] 상태 코드:', response.status);
        console.log('[Qwen API 호출 실패] 상태 텍스트:', response.statusText);
        const errText = await response.text();
        console.log('[Qwen API 호출 실패] 응답 본문:', errText);
        return { success: false, error: `API 오류 (${response.status}): ${response.statusText}` };
      }
      const data = await response.json();
      console.log(`[Qwen API 응답] JSON 파싱 성공`);
      
      // Qwen API OpenAI 호환 응답 구조 처리
      const choice = data.choices?.[0];
      if (!choice?.message?.content) {
        console.log('[Qwen API 응답 구조 오류]', {
          hasChoices: !!data.choices,
          choicesLength: data.choices?.length || 0,
          hasMessage: !!choice?.message,
          hasContent: !!choice?.message?.content,
          responseKeys: Object.keys(data || {})
        });
        return { success: false, error: 'Qwen API에서 유효한 응답을 받지 못했습니다. API 키 또는 요청 형식을 확인해주세요.' };
      }

      const responseText = choice.message.content;

      if (!responseText) {
        console.log('[Qwen API 응답 파싱 실패] 빈 응답');
        return { success: false, error: 'Qwen API 응답에서 텍스트를 추출할 수 없습니다.' };
      }

      console.log(`[Qwen API 성공] 응답 길이: ${responseText.length} 문자`);
      return { success: true, text: responseText };
    } catch (e) {
      retryCount++;
      console.log(`[Qwen API 호출 오류] 재시도 ${retryCount}/${maxRetries}:`, e.message);
      console.log(`[Qwen API 호출 오류] 스택:`, e.stack);
      if (retryCount < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        return { success: false, error: `API 호출 오류: ${e.message}` };
      }
    }
  }
  return { success: false, error: '최대 재시도 횟수 초과' };
}

/**
 * 부적절한 내용 분석 함수 (강화된 버전)
 * @param {string} responseText - API 응답 텍스트
 * @returns {Object} - 부적절 여부와 이유들
 */
function isInappropriateContent(responseText) {
  console.log(`[파싱 시작] 응답 텍스트 분석 중...`);
  
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
  const lines = responseText.split(/\r?\n/);
  console.log(`[파싱] 총 ${lines.length}개 줄 분석`);
  
  lines.forEach((line, lineIndex) => {
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
      console.log(`[파싱] 줄 ${lineIndex + 1}: 카테고리 ${idx} = ${val ? 'TRUE' : 'false'} | "${line.trim()}"`);
      if (val && categoryMap[idx]) {
        flagged.push(categoryMap[idx]);
        console.log(`[파싱] ⚠️ 부적절 카테고리 감지: ${categoryMap[idx]}`);
      }
    }
  });

  console.log(`[파싱 완료] 총 ${flagged.length}개 부적절 카테고리 검출`);
  
  return {
    isInappropriate: flagged.length > 0,
    reasons: flagged
  };
}

