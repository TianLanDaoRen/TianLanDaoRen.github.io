// 💡 Vercel Node.js Runtime
export const config = {
  runtime: 'nodejs',
};

export const maxDuration = 300;

// 读取请求体（Node.js 兼容）
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// Token 缓存
const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60 * 60; // 3小时（秒）
let tokenInfo = {
  endpoint: null,
  token: null,
  expiredAt: null,
};

// CORS 头
function makeCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Max-Age': '86400',
  };
}

// XML 转义
function escapeXmlText(text) {
  return text.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 日期格式化
function dateFormat() {
  return new Date().toUTCString().replace(/GMT/, '').trim() + ' GMT';
}

// UUID
function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

// Base64 工具
async function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

// HMAC-SHA256 签名
async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

// 签名函数
async function sign(urlStr) {
  const url = urlStr.split('://')[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = uuid();
  const formattedDate = dateFormat();
  const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
  const decode = await base64ToBytes('oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==');
  const signData = await hmacSha256(decode, bytesToSign);
  const signBase64 = await bytesToBase64(signData);
  return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

// 获取 Edge TTS Endpoint
async function getEndpoint() {
  const now = Date.now() / 1000;
  if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
    return tokenInfo.endpoint;
  }

  const endpointUrl = 'https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0';
  const clientId = crypto.randomUUID().replace(/-/g, '');

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Accept-Language': 'zh-Hans',
        'X-ClientVersion': '4.0.530a 5fe1dc6c',
        'X-UserId': '0f04d16a175c411e',
        'X-HomeGeographicRegion': 'zh-Hans-CN',
        'X-ClientTraceId': clientId,
        'X-MT-Signature': await sign(endpointUrl),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': '0',
        'Accept-Encoding': 'gzip',
      },
    });

    if (!response.ok) {
      throw new Error(`获取endpoint失败: ${response.status}`);
    }

    const data = await response.json();
    const jwt = data.t.split('.')[1];
    const decodedJwt = JSON.parse(atob(jwt));
    tokenInfo = {
      endpoint: data,
      token: data.t,
      expiredAt: decodedJwt.exp,
    };
    return data;
  } catch (error) {
    console.error('获取endpoint失败:', error);
    if (tokenInfo.token) {
      console.log('使用过期的缓存token');
      return tokenInfo.endpoint;
    }
    throw error;
  }
}

// 生成 SSML
function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0) {
  const escapedText = escapeXmlText(text);
  let slienStr = '';
  if (slien > 0) {
    slienStr = `<break time="${slien}ms" />`;
  }
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
    <voice name="${voiceName}">
      <mstts:express-as style="${style}" styledegree="2.0" role="default">
        <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapedText}</prosody>
      </mstts:express-as>
      ${slienStr}
    </voice>
  </speak>`;
}

// 获取音频块
async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat = 'audio-24khz-48kbitrate-mono-mp3', maxRetries = 3) {
  const retryDelay = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const endpoint = await getEndpoint();
      const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

      let m = text.match(/\[(\d+)\]\s*?$/);
      let slien = 0;
      if (m && m.length === 2) {
        slien = parseInt(m[1]);
        text = text.replace(m[0], '');
      }

      if (!text.trim()) {
        throw new Error('文本块为空');
      }
      if (text.length > 2000) {
        throw new Error(`文本块过长: ${text.length} 字符，最大支持2000字符`);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': endpoint.t,
          'Content-Type': 'application/ssml+xml',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'X-Microsoft-OutputFormat': outputFormat,
        },
        body: getSsml(text, voiceName, rate, pitch, volume, style, slien),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          if (attempt < maxRetries) {
            console.log(`频率限制，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
            await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
            continue;
          }
          throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
        } else if (response.status >= 500) {
          if (attempt < maxRetries) {
            console.log(`服务器错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
            await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
            continue;
          }
          throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
        } else {
          throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
        }
      }

      return await response.blob();
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`音频生成失败（已重试${maxRetries}次）: ${error.message}`);
      }
      if (error.message.includes('fetch') || error.message.includes('network')) {
        console.log(`网络错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

// 延迟
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 优化文本分块
function optimizedTextSplit(text, maxChunkSize = 1500) {
  const chunks = [];
  const sentences = text.split(/[。！？\n]/);
  let currentChunk = '';

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    if (trimmedSentence.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      for (let i = 0; i < trimmedSentence.length; i += maxChunkSize) {
        chunks.push(trimmedSentence.slice(i, i + maxChunkSize));
      }
    } else if ((currentChunk + trimmedSentence).length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = trimmedSentence;
    } else {
      currentChunk += (currentChunk ? '。' : '') + trimmedSentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.length > 0);
}

// 批量处理音频块
async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, batchSize = 3, delayMs = 1000) {
  const audioChunks = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchPromises = batch.map(async (chunk, index) => {
      try {
        if (index > 0) {
          await delay(index * 200);
        }
        return await getAudioChunk(chunk, voiceName, rate, pitch, volume, style, outputFormat);
      } catch (error) {
        console.error(`处理音频块失败 (批次 ${Math.floor(i / batchSize) + 1}, 块 ${index + 1}):`, error);
        throw error;
      }
    });
    try {
      const batchResults = await Promise.all(batchPromises);
      audioChunks.push(...batchResults);
      if (i + batchSize < chunks.length) {
        await delay(delayMs);
      }
    } catch (error) {
      console.error('批次处理失败:', error);
      throw error;
    }
  }
  return audioChunks;
}

// 语音合成主函数
async function getVoice(text, voiceName = 'zh-CN-XiaoxiaoNeural', rate = '+0%', pitch = '+0Hz', volume = '+0%', style = 'general', outputFormat = 'audio-24khz-48kbitrate-mono-mp3') {
  try {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('文本内容为空');
    }

    if (cleanText.length <= 1500) {
      const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat);
      return { audio: audioBlob, contentType: 'audio/mpeg' };
    }

    const chunks = optimizedTextSplit(cleanText, 1500);
    if (chunks.length > 40) {
      throw new Error(`文本过长，分块数量(${chunks.length})超过限制。请缩短文本或分批处理。`);
    }

    console.log(`文本已分为 ${chunks.length} 个块进行处理`);
    const audioChunks = await processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, 3, 800);
    const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
    return { audio: concatenatedAudio, contentType: 'audio/mpeg' };
  } catch (error) {
    console.error('语音合成失败:', error);
    throw error;
  }
}

// 处理 TTS 请求
async function handleTTS(request) {
  const contentType = request.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    // 使用 Web FormData API（Vercel Runtime 支持）
    const formData = await request.formData();
    const file = formData.get('file');
    const voice = formData.get('voice') || 'zh-CN-XiaoxiaoNeural';
    const speed = formData.get('speed') || '1.0';
    const volume = formData.get('volume') || '0';
    const pitch = formData.get('pitch') || '0';
    const style = formData.get('style') || 'general';

    if (!file) {
      throw { status: 400, message: '未找到上传的文件', code: 'missing_file' };
    }
    if (!file.type.includes('text/') && !file.name.toLowerCase().endsWith('.txt')) {
      throw { status: 400, message: '不支持的文件类型，请上传txt文件', code: 'invalid_file_type' };
    }
    if (file.size > 500 * 1024) {
      throw { status: 400, message: '文件大小超过限制（最大500KB）', code: 'file_too_large' };
    }

    const text = await file.text();
    if (!text.trim()) {
      throw { status: 400, message: '文件内容为空', code: 'empty_file' };
    }
    if (text.length > 10000) {
      throw { status: 400, message: '文本内容过长（最大10000字符）', code: 'text_too_long' };
    }

    const rate = parseInt(String((parseFloat(speed) - 1) * 100));
    const numVolume = parseInt(String(parseFloat(volume) * 100));
    const numPitch = parseInt(pitch);

    const result = await getVoice(
      text,
      voice,
      rate >= 0 ? `+${rate}%` : `${rate}%`,
      numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
      numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
      style,
      'audio-24khz-48kbitrate-mono-mp3'
    );
    return result;
  }

  // JSON 请求体 - 使用 Node.js 方式读取
  const rawBody = await readBody(request);
  const body = JSON.parse(rawBody);
  const {
    input,
    voice = 'zh-CN-XiaoxiaoNeural',
    speed = '1.0',
    volume = '0',
    pitch = '0',
    style = 'general',
  } = body;

  const rate = parseInt(String((parseFloat(speed) - 1) * 100));
  const numVolume = parseInt(String(parseFloat(volume) * 100));
  const numPitch = parseInt(pitch);

  const result = await getVoice(
    input,
    voice,
    rate >= 0 ? `+${rate}%` : `${rate}%`,
    numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
    numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
    style,
    'audio-24khz-48kbitrate-mono-mp3'
  );
  return result;
}

// 处理语音转文字
async function handleTranscription(request) {
  if (request.method !== 'POST') {
    throw { status: 405, message: '只支持POST方法', code: 'method_not_allowed' };
  }

  const contentType = request.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    throw { status: 400, message: '请求必须使用multipart/form-data格式', code: 'invalid_content_type' };
  }

  const formData = await request.formData();
  const audioFile = formData.get('file');
  const customToken = formData.get('token');

  if (!audioFile) {
    throw { status: 400, message: '未找到音频文件', code: 'missing_file' };
  }
  if (audioFile.size > 10 * 1024 * 1024) {
    throw { status: 400, message: '音频文件大小不能超过10MB', code: 'file_too_large' };
  }

  const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/flac', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/amr', 'audio/3gpp'];
  const isValidType = allowedTypes.some(type =>
    audioFile.type.includes(type) ||
    audioFile.name.toLowerCase().match(/\.(mp3|wav|m4a|flac|aac|ogg|webm|amr|3gp)$/i)
  );

  if (!isValidType) {
    throw { status: 400, message: '不支持的音频文件格式，请上传mp3、wav、m4a、flac、aac、ogg、webm、amr或3gp格式的文件', code: 'invalid_file_type' };
  }

  const token = customToken || 'sk-wtldsvuprmwltxpbspbmawtolbacghzawnjhtlzlnujjkfhh';

  const apiFormData = new FormData();
  apiFormData.append('file', audioFile);
  apiFormData.append('model', 'FunAudioLLM/SenseVoiceSmall');

  const apiResponse = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: apiFormData,
  });

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();
    console.error('硅基流动API错误:', apiResponse.status, errorText);

    let errorMessage = '语音转录服务暂时不可用';
    if (apiResponse.status === 401) {
      errorMessage = 'API Token无效，请检查您的配置';
    } else if (apiResponse.status === 429) {
      errorMessage = '请求过于频繁，请稍后再试';
    } else if (apiResponse.status === 413) {
      errorMessage = '音频文件太大，请选择较小的文件';
    }

    throw { status: apiResponse.status, message: errorMessage, code: 'transcription_api_error' };
  }

  return await apiResponse.json();
}

// HTML 页面
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VoiceCraft - AI 语音处理平台</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .container{max-width:600px;padding:40px;text-align:center}
    h1{font-size:2.5rem;color:#2563eb;margin-bottom:16px}
    p{color:#475569;margin-bottom:24px;line-height:1.6}
    .features{display:flex;gap:24px;justify-content:center;flex-wrap:wrap;margin-bottom:32px}
    .feature{background:#fff;padding:16px 24px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
    .feature-icon{font-size:1.5rem;margin-bottom:8px}
    .feature-text{font-size:0.9rem;color:#475569}
    .api-info{background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);text-align:left}
    .api-info h3{margin-bottom:12px;color:#0f172a}
    .api-endpoint{background:#f1f5f9;padding:8px 12px;border-radius:6px;font-family:monospace;font-size:0.85rem;color:#475569;margin-bottom:8px}
    a{color:#2563eb;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="container">
    <h1>🎤 VoiceCraft</h1>
    <p>AI 驱动的语音处理平台</p>
    <div class="features">
      <div class="feature">
        <div class="feature-icon">🗣️</div>
        <div class="feature-text">文字转语音<br>20+ 中文语音</div>
      </div>
      <div class="feature">
        <div class="feature-icon">📝</div>
        <div class="feature-text">语音转文字<br>支持多格式</div>
      </div>
      <div class="feature">
        <div class="feature-icon">⚡</div>
        <div class="feature-text">极速处理<br>Edge TTS</div>
      </div>
    </div>
    <div class="api-info">
      <h3>API 接口</h3>
      <div class="api-endpoint">POST /v1/audio/speech</div>
      <div class="api-endpoint">POST /v1/audio/transcriptions</div>
      <p style="margin-top:16px;font-size:0.85rem">
        文档：<a href="https://github.com/your-repo/voicecraft">GitHub</a>
      </p>
    </div>
  </div>
</body>
</html>`;

// 主处理函数
export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'tts.gualing.top'}`);
  const pathname = url.pathname;

  // 设置 CORS 头
  const corsHeaders = makeCORSHeaders();
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  // OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    // 首页 HTML
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML_PAGE);
    }

    // TTS 语音合成
    if (pathname === '/v1/audio/speech') {
      const result = await handleTTS(req);
      const arrayBuffer = await result.audio.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      res.writeHead(200, { 'Content-Type': result.contentType });
      return res.end(buffer);
    }

    // 语音转文字
    if (pathname === '/v1/audio/transcriptions') {
      const result = await handleTranscription(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }

    // 其他路径返回 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  } catch (error) {
    console.error('请求处理错误:', error);

    const statusCode = error.status || 500;
    const errorCode = error.code || 'internal_error';
    const errorMessage = error.message || '服务器内部错误';

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: {
        message: errorMessage,
        type: 'api_error',
        param: null,
        code: errorCode,
      },
    }));
  }
}
