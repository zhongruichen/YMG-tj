import { NextRequest, NextResponse } from 'next/server';

// 统一的流处理函数，将上游流转换为前端期望的格式
function transformStream(response: Response): NextResponse {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (!response.body) {
        controller.close();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // 处理缓冲区中剩余的任何数据
            if (buffer.length > 0) {
              // 在这里可以添加对最后一部分数据的处理逻辑
              console.log('处理缓冲区剩余数据:', buffer);
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后可能不完整的一行

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.substring(6).trim();
              if (dataStr === '[DONE]') {
                console.log('✅ 收到并转发[DONE]信号');
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                continue;
              }
              try {
                const upstreamJson = JSON.parse(dataStr);
                const textChunk = upstreamJson.choices?.[0]?.delta?.content;

                // 即使textChunk是空字符串也发送，因为这可能是模型思考过程中的心跳信号
                if (textChunk !== undefined && textChunk !== null) {
                  const clientJson = { text: textChunk };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(clientJson)}\n\n`));
                }
              } catch (e) {
                console.error('❌ 解析流JSON失败:', dataStr, e);
                // 即使解析失败，也可能需要将原始数据转发或记录
              }
            }
          }
        }
      } catch (error) {
        console.error('❌ 转换流时出错:', error);
        controller.error(error);
      } finally {
        reader.releaseLock();
        controller.close();
        console.log('✅ 流式响应转换和转发完成');
      }
    }
  });

  const headers = new Headers();
  response.headers.forEach((value, key) => {
    headers.append(key, value);
  });
  headers.set("X-Accel-Buffering", "no");
  headers.set("Content-Type", "text/event-stream; charset=utf-8"); // 确保前端正确解析

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}

// 安全检查 - 防止SSRF攻击
function performSSRFCheck(url: string): NextResponse | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // 允许本地主机地址
    const allowedHosts = ['localhost', '127.0.0.1'];
    if (allowedHosts.includes(hostname)) {
      return null; // 允许访问
    }

    // 检查其他私有和保留地址
    const dangerousPatterns = [
      /^192\.168\./, // Private IP range for IPv4
      /^10\./,       // Private IP range for IPv4
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private IP range for IPv4
      /^169\.254\./, // Link-local addresses
      /^fd[0-9a-f]{2}:/i, // IPv6 private range
      /^fe80::/i,     // IPv6 link-local
      /\.local$/,   // .local TLD - often used for mDNS
      /\.internal$/,// .internal TLD
    ];

    if (dangerousPatterns.some(pattern => pattern.test(hostname))) {
      console.error('❌ 禁止访问内网地址:', hostname);
      return NextResponse.json({ error: '禁止访问内网地址' }, { status: 403 });
    }

    return null; // 地址安全，允许访问
  } catch (e) {
    // URL格式无效
    return NextResponse.json({ error: '无效的URL格式' }, { status: 400 });
  }
}

// 统一的非流式响应处理函数
async function handleNonStreamingResponse(response: Response): Promise<NextResponse> {
  const contentType = response.headers.get('content-type') || '';
  let responseData: any;
  try {
    if (contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }
  } catch (parseError) {
    console.error('❌ 解析非流式响应失败:', parseError);
    responseData = await response.text();
  }

  return NextResponse.json({
    success: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: responseData,
    contentType
  });
}

export async function POST(request: NextRequest) {
  console.log('📥 代理API被调用 (POST)');

  try {
    const requestData = await request.json();
    const { url, method = 'GET', headers = {}, body: requestBody } = requestData;

    if (!url) {
      return NextResponse.json({ error: '缺少URL参数' }, { status: 400 });
    }

    // 执行SSRF检查
    const ssrfError = performSSRFCheck(url);
    if (ssrfError) return ssrfError;

    const proxyHeaders: Record<string, string> = { ...headers };
    const dangerousHeaders = ['host', 'origin', 'referer', 'user-agent', 'accept'];
    dangerousHeaders.forEach(h => delete proxyHeaders[h]);

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: proxyHeaders,
      body: ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ? requestBody : undefined,
    };

    const response = await fetch(url, fetchOptions);
    console.log(`📨 收到上游响应: ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return transformStream(response);
    } else {
      return handleNonStreamingResponse(response);
    }

  } catch (error: any) {
    console.error('❌ POST代理请求出错:', error);
    return NextResponse.json({ error: `代理请求失败: ${error.message}` }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  console.log('📥 代理API被调用 (GET)');
  const url = request.nextUrl.searchParams.get('url');
  
  if (!url) {
    return NextResponse.json({ error: '缺少URL参数' }, { status: 400 });
  }

  // 执行SSRF检查
  const ssrfError = performSSRFCheck(url);
  if (ssrfError) return ssrfError;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'MMG2-Proxy/1.0' }
    });
    console.log(`📨 收到上游响应: ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return transformStream(response);
    } else {
      return handleNonStreamingResponse(response);
    }

  } catch (error: any) {
    console.error('❌ GET代理请求失败:', error);
    return NextResponse.json({ error: `GET代理请求失败: ${error.message}` }, { status: 500 });
  }
}
