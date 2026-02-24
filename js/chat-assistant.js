/**
 * 卦灵解惑模块 (Context-aware LLM Chat Assistant)
 * 独立组件，负责管理悬浮UI、本地缓存(上下文)和追问接口调用。
 */
class GuaLingChat {
    constructor(config = {}) {
        this.apiUrl = config.apiUrl || 'https://yunsisanren.top/v1beta/models/gemini-3-flash-preview:generateContent';
        this.storageKey = 'gualing_chat_session';
        this.dom = {};
        this.isLoading = false;

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
            this.dom.fab.querySelector('.animate-ping')?.remove(); // 移除红点提示
            setTimeout(() => this.dom.input.focus(), 100);
            this.scrollToBottom();
        } else {
            this.dom.panel.classList.add('hidden');
        }
    }

    // 核心暴露方法1：清理会话（用户重新起卦时调用）
    clearSession() {
        localStorage.removeItem(this.storageKey);
        if (this.dom.messages) this.dom.messages.innerHTML = '';
        if (this.dom.fab) {
            this.dom.fab.classList.add('hidden');
            this.dom.panel.classList.add('hidden');
        }
    }

    // 核心暴露方法2：喂入大模型首轮上下文（出结果后调用）
    feedContext(systemPrompt, baseInfo, initialAnswer) {
        const session = {
            system: systemPrompt + "\n\n【系统指令追加】：你现在处于起卦后的‘追问环节’。请务必基于上述起出的卦象、五行生克以及你的初次解答等相关信息来回答用户的追问。回答需简明扼要，一针见血，保持扮演人物口吻一致性。",
            history: [
                { role: 'user', parts: [{ text: baseInfo }] },
                { role: 'model', parts: [{ text: initialAnswer }] }
            ]
        };
        localStorage.setItem(this.storageKey, JSON.stringify(session));

        // 唤醒悬浮窗
        this.dom.fab.classList.remove('hidden');
        this.dom.messages.innerHTML = '';

        // 渲染欢迎语
        this.renderMessage('model', "卦象已定，事主若有具体疑惑，可在此继续追问。");
        this.dispatchExportEvent(session.history); // 触发导出同步
    }

    restoreSession() {
        const data = localStorage.getItem(this.storageKey);
        if (data) {
            this.dom.fab.classList.remove('hidden');
            try {
                const session = JSON.parse(data);
                this.dom.messages.innerHTML = '';
                this.renderMessage('model', "卦象已定，事主若有具体疑惑，可在此继续追问。");
                // 渲染历史（跳过前两条basePrompt）
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

        // 2. 更新存储
        session.history.push({ role: 'user', parts: [{ text: text }] });

        // 3. 发送API请求
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: session.system }] },
                    contents: session.history
                })
            });
            const resData = await response.json();

            if (resData.candidates && resData.candidates.length > 0) {
                const aiReply = resData.candidates[0].content.parts[0].text;
                // 更新存储
                session.history.push({ role: 'model', parts: [{ text: aiReply }] });
                localStorage.setItem(this.storageKey, JSON.stringify(session));

                // UI 更新：AI 回答
                this.setLoading(false);
                this.renderMessage('model', aiReply);

                // 触发全局事件，通知主页面更新导出图片DOM
                this.dispatchExportEvent(session.history);
            } else {
                throw new Error("模型返回异常");
            }
        } catch (error) {
            console.error(error);
            this.setLoading(false);
            this.renderMessage('model', "天机阻滞，网络似有不畅，请稍后再问。");
            session.history.pop(); // 移除失败的提问
        }
    }

    renderMessage(role, text) {
        const isModel = role === 'model';
        const alignClass = isModel ? 'chat-start' : 'chat-end';
        const bubbleColor = isModel ? 'bg-white border border-[#e6ded5] text-gray-800' : 'bg-[#9e1c26] text-white';
        const avatarStr = isModel
            ? `<div class="w-8 rounded-full border border-[#d4af37]"><img src="assets/images/bokou-icon.png" /></div>`
            : `<div class="w-8 h-8 rounded-full bg-gray-200 flex items-center text-center justify-center text-gray-500"><i class="fa-solid fa-user fa-fw"></i></div>`;

        // 将Markdown解析为HTML (依赖marked.js)
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

    setLoading(isLoading) {
        this.isLoading = isLoading;
        if (isLoading) {
            const loadingDiv = document.createElement('div');
            loadingDiv.id = 'chat-loading';
            loadingDiv.className = 'chat chat-start animate-fade-in-up';
            loadingDiv.innerHTML = `
                <div class="chat-image avatar"><div class="w-8 rounded-full border border-[#d4af37]"><img src="assets/images/bokou-icon.png" /></div></div>
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
            this.dom.messages.scrollTop = this.dom.messages.scrollHeight;
        }
    }

    dispatchExportEvent(history) {
        // 将 history 派发给主页面，以便更新导出容器
        const event = new CustomEvent('gualingChatUpdated', { detail: history });
        window.dispatchEvent(event);
    }
}

// 暴露到全局供主逻辑调用
window.GuaLingChat = GuaLingChat;