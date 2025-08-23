// DashScope API 키 테스트 스크립트
// 사용법: node debug-api.js YOUR_DASHSCOPE_API_KEY

const fetch = require('node-fetch');

async function testDashScopeAPI(apiKey) {
  console.log('=== DashScope API 키 테스트 ===\n');
  
  // API 키 기본 정보
  console.log(`API 키 길이: ${apiKey.length}`);
  console.log(`API 키 앞 8자리: ${apiKey.substring(0, 8)}...`);
  console.log(`API 키 뒤 4자리: ...${apiKey.substring(apiKey.length - 4)}`);
  console.log(`API 키 형식: ${apiKey.startsWith('sk-') ? 'OpenAI 스타일 (sk-)' : 'DashScope 표준 형식'}`);
  console.log('');
  
  // 1. 간단한 텍스트 생성 테스트
  console.log('1. 텍스트 생성 API 테스트...');
  const textApiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
  
  const textRequestBody = {
    model: 'qwen-plus',
    input: {
      messages: [
        {
          role: 'user',
          content: 'Hello, please respond with "API test successful"'
        }
      ]
    },
    parameters: {
      max_tokens: 50
    }
  };
  
  try {
    const response = await fetch(textApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(textRequestBody)
    });
    
    console.log(`응답 상태: ${response.status} ${response.statusText}`);
    console.log(`응답 헤더:`, Object.fromEntries(response.headers));
    
    const textData = await response.text();
    console.log(`응답 내용:`, textData);
    
    if (response.ok) {
      console.log('✅ 텍스트 API 테스트 성공!');
    } else {
      console.log('❌ 텍스트 API 테스트 실패');
    }
  } catch (error) {
    console.log('❌ 텍스트 API 테스트 오류:', error.message);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // 2. 멀티모달 생성 API 테스트 (실제 사용하는 엔드포인트)
  console.log('2. 멀티모달 생성 API 테스트...');
  
  // 여러 가지 인증 방식 테스트
  const testMethods = [
    {
      name: 'Authorization Bearer',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    },
    {
      name: 'X-DashScope-API-Key 헤더',
      headers: { 'X-DashScope-API-Key': apiKey, 'Content-Type': 'application/json' }
    },
    {
      name: 'Authorization 직접',
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }
    }
  ];
  
  const multimodalApiUrl = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  
  const multimodalRequestBody = {
    model: 'qwen-vl-plus',
    input: {
      messages: [
        {
          role: 'user',
          content: [
            {
              text: 'Hello, this is an API test. Please respond with "Multimodal API test successful"'
            }
          ]
        }
      ]
    },
    parameters: {
      max_tokens: 50
    }
  };
  
  // 각 인증 방식 테스트
  for (let i = 0; i < testMethods.length; i++) {
    const method = testMethods[i];
    console.log(`\n테스트 ${i + 1}: ${method.name}`);
    console.log(`헤더: ${JSON.stringify(method.headers, null, 2)}`);
    
    try {
      const response = await fetch(multimodalApiUrl, {
        method: 'POST',
        headers: method.headers,
        body: JSON.stringify(multimodalRequestBody)
      });
      
      console.log(`응답 상태: ${response.status} ${response.statusText}`);
      console.log(`응답 헤더:`, Object.fromEntries(response.headers));
      
      const multimodalData = await response.text();
      console.log(`응답 내용 (첫 200자):`, multimodalData.substring(0, 200));
      
      if (response.ok) {
        console.log(`✅ ${method.name} 테스트 성공!`);
        console.log('🎉 이 인증 방식을 사용하세요!');
        break; // 성공하면 다음 테스트는 생략
      } else {
        console.log(`❌ ${method.name} 테스트 실패`);
        
        // 401 오류인 경우 추가 정보
        if (response.status === 401) {
          console.log(`🔍 ${method.name}에서 401 오류 발생`);
        }
      }
    } catch (error) {
      console.log(`❌ ${method.name} 테스트 오류:`, error.message);
    }
    
    // 각 테스트 사이에 잠깐 대기
    if (i < testMethods.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  console.log('테스트 완료!');
}

// 명령행 인수에서 API 키 가져오기
const apiKey = process.argv[2];
if (!apiKey) {
  console.log('사용법: node debug-api.js YOUR_DASHSCOPE_API_KEY');
  console.log('예제: node debug-api.js sk-1234567890abcdef...');
  process.exit(1);
}

testDashScopeAPI(apiKey);
