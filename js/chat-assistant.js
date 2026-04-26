/**
 * 卦灵解惑模块 (Context-aware LLM Chat Assistant - Streaming Edition)
 * 独立组件，负责管理悬浮UI、本地缓存(上下文)、流式输出和红点提醒。
 */
class GuaLingChat {
    constructor(config = {}) {
        this.apiUrl = config.apiUrl || 'https://yunsisanren.top/v1beta/models/gemini-3.1-flash-lite-preview:generateContent';
        this.storageKey = 'gualing_chat_session';
        this.dom = {};
        this.isLoading = false;
        this.logo = config.logo || 'assets/images/icon.png';

        // 自动转换 URL 以支持流式输出 (Gemini 标准)
        this.streamUrl = this.apiUrl.includes(':generateContent')
            ? this.apiUrl.replace(':generateContent', ':streamGenerateContent?alt=sse')
            : this.apiUrl;

        // 获取 API 根域名，用于后续探测状态和发邮件
        try {
            this.apiOrigin = new URL(this.apiUrl).origin;
        } catch {
            this.apiOrigin = window.location.origin;
        }

        // 当DOM加载完毕后初始化UI绑定
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.initDOM());
        } else {
            this.initDOM();
        }
    }

    initDOM() {
        this.dom = {
            fab: document.getElementById('chat-fab'),
            panel: document.getElementById('chat-panel'),
            closeBtn: document.getElementById('chat-close-btn'),
            messages: document.getElementById('chat-messages'),
            input: document.getElementById('chat-input'),
            sendBtn: document.getElementById('chat-send-btn')
        };

        if (!this.dom.fab) return;

        // 绑定事件
        this.dom.fab.addEventListener('click', () => this.togglePanel(true));
        this.dom.closeBtn.addEventListener('click', () => this.togglePanel(false));
        this.dom.sendBtn.addEventListener('click', () => this.sendMessage());
        this.dom.input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        // 尝试恢复之前的会话
        this.restoreSession();
    }

    togglePanel(show) {
        if (show) {
            this.dom.panel.classList.remove('hidden');
            this.updateRedDot(false); // 展开时移除红点
            setTimeout(() => this.dom.input.focus(), 100);
            this.scrollToBottom();
        } else {
            this.dom.panel.classList.add('hidden');
        }
    }

    // 更新红点状态
    updateRedDot(show) {
        let dot = this.dom.fab.querySelector('.chat-notification-dot');
        if (show) {
            // 只有当面板是隐藏状态时，才显示红点
            if (this.dom.panel.classList.contains('hidden') && !dot) {
                const dotHtml = `
                <span class="chat-notification-dot absolute top-0 right-0 flex h-3 w-3">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
                </span>`;
                this.dom.fab.insertAdjacentHTML('beforeend', dotHtml);
            }
        } else {
            if (dot) dot.remove();
        }
    }

    clearSession() {
        localStorage.removeItem(this.storageKey);
        if (this.dom.messages) this.dom.messages.innerHTML = '';
        if (this.dom.fab) {
            this.dom.fab.classList.add('hidden');
            this.dom.panel.classList.add('hidden');
            this.updateRedDot(false);
        }
    }

    feedContext(systemPrompt, baseInfo, initialAnswer) {
        const session = {
            system: systemPrompt + "\n\n【系统指令追加】：你现在处于起卦后的‘追问环节’。请务必基于上述起出的卦象、五行生克以及你的初次解答等相关信息来回答用户的追问。回答需简明扼要，一针见血，保持扮演人物口吻一致性。",
            history: [
                { role: 'user', parts: [{ text: baseInfo }] },
                { role: 'model', parts: [{ text: initialAnswer }] }
            ]
        };
        localStorage.setItem(this.storageKey, JSON.stringify(session));

        this.dom.fab.classList.remove('hidden');
        this.dom.messages.innerHTML = '';

        this.renderMessage('model', "感谢使用卦灵AI！居士若有具体疑惑，可在此提问。</br>若您觉得卦灵AI对您有帮助，您可以\n**[☕ 点击此处随喜打赏 / 赞助恩师云笥散人](https://yunsisanren.top/donate.png)**\n**[🎁 点击此处：验证 Steam 免费领取《石楠小馆：一斗浮生》激活码](https://gualing.top/cdkey.html)**");
        this.updateRedDot(true); // 首轮结果出来后，唤醒红点提示
        this.dispatchExportEvent(session.history);
    }

    restoreSession() {
        const data = localStorage.getItem(this.storageKey);
        if (data) {
            this.dom.fab.classList.remove('hidden');
            try {
                const session = JSON.parse(data);
                this.dom.messages.innerHTML = '';
                this.renderMessage('model', "感谢使用卦灵AI！居士若有具体疑惑，可在此提问。</br>若您觉得卦灵AI对您有帮助，您可以\n**[☕ 点击此处随喜打赏 / 赞助恩师云笥散人](https://yunsisanren.top/donate.png)**\n**[🎁 点击此处：验证 Steam 免费领取《石楠小馆：一斗浮生》激活码](https://gualing.top/cdkey.html)**");
                for (let i = 2; i < session.history.length; i++) {
                    const msg = session.history[i];
                    this.renderMessage(msg.role, msg.parts[0].text);
                }
                this.dispatchExportEvent(session.history);
            } catch (e) {
                this.clearSession();
            }
        }
    }

    async sendMessage() {
        const text = this.dom.input.value.trim();
        if (!text || this.isLoading) return;

        const dataStr = localStorage.getItem(this.storageKey);
        if (!dataStr) return;
        const session = JSON.parse(dataStr);

        // 1. UI 更新：用户提问
        this.dom.input.value = '';
        this.renderMessage('user', text);
        this.setLoading(true);

        // 2. 更新存储 (发送给API的历史)
        session.history.push({ role: 'user', parts: [{ text: text }] });

        // 3. 发送流式API请求
        try {
            const response = await fetch(this.streamUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: session.system }] },
                    contents: session.history,
                    generationConfig: {
                        temperature: 1.0,
                        thinkingConfig: {
                            thinkingLevel: "HIGH",
                        },
                    },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                    ],
                    tools: [{ googleSearch: {} }],
                })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            // 移除 Loading，准备流式打字机渲染
            this.setLoading(false);

            // 创建一个空的AI气泡容器
            const aiBubbleContentNode = this.createEmptyAiBubble();
            let aiReply = ''; // 累加流式文本

            // 获取可读流读取器
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            // 持续读取流
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // 保留最后一行（可能不完整）到下一次处理
                buffer = lines.pop();

                for (let line of lines) {
                    line = line.trim();
                    if (line.startsWith('data: ')) {
                        if (line === 'data: [DONE]') continue;
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.candidates && data.candidates.length > 0) {
                                const parts = data.candidates[0].content?.parts;
                                if (parts && parts.length > 0) {
                                    // 累加文本并实时渲染 Markdown
                                    aiReply += parts[0].text;
                                    aiBubbleContentNode.innerHTML = window.marked ? marked.parse(aiReply) : aiReply;
                                    this.scrollToBottom(); // 滚动到底部
                                }
                            }
                        } catch (e) {
                        }
                    }
                }
            }

            // 对话结束后的收尾工作
            session.history.push({ role: 'model', parts: [{ text: aiReply }] });
            localStorage.setItem(this.storageKey, JSON.stringify(session));

            // 触发导出事件
            this.dispatchExportEvent(session.history);

            // 触发红点
            this.updateRedDot(true);

            if (aiReply.trim() === '') {
                throw new Error("AI 返回内容为空");
            }
        } catch (error) {
            this.setLoading(false);

            // 【修改点】发生错误时，渲染带有节点状态检测和管理员通知功能的卡片
            this.renderErrorCard();
            session.history.pop();
        }
    }

    // 常规渲染完整消息
    renderMessage(role, text) {
        const isModel = role === 'model';
        const alignClass = isModel ? 'chat-start' : 'chat-end';
        const bubbleColor = isModel ? 'bg-white border border-[#e6ded5] text-gray-800' : 'bg-[#9e1c26] text-white';
        const avatarStr = isModel
            ? `<div class="w-8 rounded-full border border-[#d4af37]"><img src="${this.logo}" /></div>`
            : `<div class="w-8 h-8 rounded-full bg-gray-200 flex items-center text-center justify-center text-gray-500"><i class="fa-solid fa-user fa-fw"></i></div>`;

        const contentHTML = isModel ? (window.marked ? marked.parse(text) : text) : text;

        const chatDiv = document.createElement('div');
        chatDiv.className = `chat ${alignClass} animate-fade-in-up`;
        chatDiv.innerHTML = `
            <div class="chat-image avatar">${avatarStr}</div>
            <div class="chat-bubble ${bubbleColor} text-sm shadow-sm prose prose-sm max-w-xs leading-relaxed break-words">${contentHTML}</div>
        `;
        this.dom.messages.appendChild(chatDiv);
        this.scrollToBottom();
    }

    // =================================================================
    // ⬇️ 新增：错误卡片及网络诊断模块 ⬇️
    // =================================================================
    renderErrorCard() {
        const uniqueId = Date.now();
        const statusContainerId = `status-container-${uniqueId}`;
        const notifyBtnId = `notify-btn-${uniqueId}`;

        const htmlContent = `
            <div class="p-3 border border-red-200 bg-red-50 rounded-lg text-sm text-gray-700 mt-1 mb-1 shadow-sm w-full font-sans">
                <div class="flex items-center text-red-600 font-bold mb-2 text-base">
                    <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    天机阻滞，连接失败
                </div>
                
                <p class="mb-3 text-xs leading-relaxed text-gray-600">无法连接至云端执行节点。<br/>👉 <strong class="text-gray-800">请先检查您的本地网络（Wi-Fi/数据）是否正常。</strong>若您的网络通畅，则可能是服务器节点异常。</p>
                
                <div id="${statusContainerId}" class="bg-white p-2 rounded border border-red-100 text-xs mb-3 text-gray-500 flex items-center justify-center min-h-[50px] shadow-inner transition-all duration-300">
                    <span class="loading loading-spinner loading-xs text-red-400 mr-2"></span> 正在探测集群状态...
                </div>
                
                <button id="${notifyBtnId}" class="w-full py-2 px-3 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-xs font-semibold rounded shadow transition-colors flex items-center justify-center">
                    <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                    确认自身网络正常，通知管理员
                </button>
            </div>
        `;

        const chatDiv = document.createElement('div');
        chatDiv.className = `chat chat-start animate-fade-in-up w-full`;
        // 使用透明背景的气泡，让内部的卡片自己撑起样式
        chatDiv.innerHTML = `
            <div class="chat-image avatar">
                <div class="w-8 rounded-full border border-[#d4af37]"><img src="${this.logo}" /></div>
            </div>
            <div class="chat-bubble bg-transparent p-0 shadow-none w-full max-w-[280px]">${htmlContent}</div>
        `;
        this.dom.messages.appendChild(chatDiv);
        this.scrollToBottom();

        // 触发状态探测和绑定按钮事件
        this.fetchAndRenderStatus(statusContainerId);
        this.bindNotifyEvent(notifyBtnId);
    }

    async fetchAndRenderStatus(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        try {
            const res = await fetch(`${this.apiOrigin}/v1beta/sys/status`, { method: 'POST', timeout: 5000 });
            if (!res.ok) throw new Error('Status fetch failed');
            const data = await res.json();

            const nodeColor = data.totalNodes > 0 ? 'text-green-600' : 'text-red-600 font-bold';

            container.innerHTML = `
                <div class="w-full text-left">
                    <div class="flex justify-between mb-1"><span class="text-gray-500">网关服务:</span> <span class="text-green-600">运行中 <i class="fa-solid fa-check-circle"></i></span></div>
                    <div class="flex justify-between mb-1"><span class="text-gray-500">存活节点:</span> <span class="${nodeColor}">${data.totalNodes} 个</span></div>
                    <div class="flex justify-between"><span class="text-gray-500">排队任务:</span> <span class="text-orange-500">${data.totalPendingTasks} 个</span></div>
                </div>
            `;
        } catch (err) {
            container.innerHTML = `<div class="text-red-500 flex items-center justify-center"><i class="fa-solid fa-circle-xmark mr-1"></i> 获取网关状态失败 (网关可能离线或您的网络断开)</div>`;
        }
    }

    bindNotifyEvent(btnId) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        btn.addEventListener('click', async () => {
            btn.innerHTML = `<span class="loading loading-spinner loading-xs mr-1"></span> 发送中...`;
            btn.disabled = true;
            btn.classList.add('opacity-80', 'cursor-not-allowed');

            try {
                const res = await fetch(`${this.apiOrigin}/v1beta/sys/notify_admin`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: '【前端故障上报】用户在前端网页遇到了网络阻滞错误，已确认自身网络正常，请求管理员检查后端集群节点健康状态。' })
                });

                if (!res.ok) throw new Error('Notify failed');

                btn.className = "w-full py-2 px-3 bg-green-600 text-white text-xs font-semibold rounded shadow flex items-center justify-center cursor-default transition-colors";
                btn.innerHTML = `<svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> 已成功发信给管理员`;
            } catch (err) {
                btn.className = "w-full py-2 px-3 bg-gray-500 text-white text-xs font-semibold rounded shadow flex items-center justify-center cursor-default transition-colors";
                btn.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-1"></i> 通知发送失败 (网关完全失联)`;
            }
        });
    }
    // =================================================================

    // 为流式输出创建一个空的AI气泡，并返回内部的文本容器节点
    createEmptyAiBubble() {
        const chatDiv = document.createElement('div');
        chatDiv.className = `chat chat-start animate-fade-in-up`;

        // 赋予一个特有的ID便于内部定位
        chatDiv.innerHTML = `
            <div class="chat-image avatar">
                <div class="w-8 rounded-full border border-[#d4af37]"><img src="${this.logo}" /></div>
            </div>
            <div class="chat-bubble bg-white border border-[#e6ded5] text-gray-800 text-sm shadow-sm prose prose-sm max-w-xs leading-relaxed break-words streaming-content">
                <!-- 流式内容将灌入此处 -->
            </div>
        `;
        this.dom.messages.appendChild(chatDiv);
        this.scrollToBottom();

        // 返回用来装填文字的容器节点
        return chatDiv.querySelector('.streaming-content');
    }

    setLoading(isLoading) {
        this.isLoading = isLoading;
        if (isLoading) {
            const loadingDiv = document.createElement('div');
            loadingDiv.id = 'chat-loading';
            loadingDiv.className = 'chat chat-start animate-fade-in-up';
            loadingDiv.innerHTML = `
                <div class="chat-image avatar"><div class="w-8 rounded-full border border-[#d4af37]"><img src="${this.logo}" /></div></div>
                <div class="chat-bubble bg-white border border-[#e6ded5]"><span class="loading loading-dots loading-sm text-[#9e1c26]"></span></div>
            `;
            this.dom.messages.appendChild(loadingDiv);
            this.scrollToBottom();
        } else {
            document.getElementById('chat-loading')?.remove();
        }
    }

    scrollToBottom() {
        if (this.dom.messages) {
            // 使用平滑滚动或直接设置，打字机期间直接设置体验更好
            this.dom.messages.scrollTop = this.dom.messages.scrollHeight;
        }
    }

    dispatchExportEvent(history) {
        const event = new CustomEvent('gualingChatUpdated', { detail: history });
        window.dispatchEvent(event);
    }
}

window.GuaLingChat = GuaLingChat;