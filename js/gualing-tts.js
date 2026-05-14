/**
 * 卦灵AI 全局 TTS 调度中心 (直连 Cloudflare 版)
 */
const GuaLingTTS = (function () {
    const WORKER_URL = 'https://tts-voice-magic.moriartylimitter.workers.dev/v1/audio/speech';

    let currentAudio = null;
    let audioQueue = [];
    let isPlaying = false;
    let lastProcessedIndex = 0; // 记录流式文本已切片的索引
    let currentActiveBtn = null; // 当前正在控制播放的按钮 DOM

    // 匹配中文或英文的断句符
    const sentenceEnder = /【。！？\n】|(\.\s)|(!\s)|(\?\s)/;

    // 清洗文本：移除 Markdown 标记，让读音自然
    function cleanText(text) {
        return text.replace(/\*\*/g, '')
            .replace(/###/g, '')
            .replace(/--/g, '')
            .replace(/\*/g, '')
            .replace(/#/g, '');
    }

    // 调用 Cloudflare Workers
    async function fetchAudioBlob(text) {
        if (!text.trim()) return null;
        try {
            const response = await fetch(WORKER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: cleanText(text),
                    voice: "zh-CN-YunzeNeural", // 默认男声，居士可改为 XiaoxiaoNeural
                    speed: 1.25,
                    pitch: "-5",
                    style: "affectionate"
                })
            });
            if (!response.ok) return null;
            return await response.blob();
        } catch (e) { return null; }
    }

    return {
        // 1. 播放单块文本 (历史回溯或固定气泡)
        playOnce: async function (text, btn) {
            if (this.isThisBtnPlaying(btn)) {
                this.stop();
                return;
            }
            this.stop();
            currentActiveBtn = btn;
            this.updateBtnUI('loading');

            const blob = await fetchAudioBlob(text);
            if (!blob) {
                this.stop();
                return;
            }

            this.startPlayback(URL.createObjectURL(blob));
        },

        // 2. 流式文本感知 (每收到一个 chunk 调用一次)
        handleStream: function (fullText, btn) {
            // 如果用户手动点过别的按钮播放，则不自动播放当前流
            if (currentActiveBtn && currentActiveBtn !== btn) return;

            currentActiveBtn = btn;
            const pendingText = fullText.substring(lastProcessedIndex);

            const match = pendingText.match(sentenceEnder);
            if (match) {
                const sentence = pendingText.substring(0, match.index + 1);
                lastProcessedIndex += (match.index + 1);
                this.enqueue(sentence);
            }
        },

        // 3. 内部队列逻辑
        enqueue: async function (sentence) {
            const blob = await fetchAudioBlob(sentence);
            if (blob) {
                audioQueue.push(URL.createObjectURL(blob));
                if (!isPlaying) this.playNextInQueue();
            }
        },

        playNextInQueue: function () {
            if (audioQueue.length === 0) {
                // 队列空了，检查是否流式还没发完
                isPlaying = false;
                this.updateBtnUI('idle');
                return;
            }
            const url = audioQueue.shift();
            this.startPlayback(url, true);
        },

        startPlayback: function (url, isFromQueue = false) {
            isPlaying = true;
            this.updateBtnUI('playing');

            if (currentAudio) currentAudio.pause();
            currentAudio = new Audio(url);

            currentAudio.onended = () => {
                URL.revokeObjectURL(url); // 释放内存
                if (isFromQueue) {
                    this.playNextInQueue();
                } else {
                    this.stop();
                }
            };
            currentAudio.play().catch(() => this.stop());
        },

        stop: function () {
            if (currentAudio) {
                currentAudio.pause();
                currentAudio = null;
            }
            audioQueue.forEach(url => URL.revokeObjectURL(url));
            audioQueue = [];
            isPlaying = false;
            lastProcessedIndex = 0;
            this.updateBtnUI('idle');
            currentActiveBtn = null;
        },

        isThisBtnPlaying: function (btn) {
            return currentActiveBtn === btn && isPlaying;
        },

        updateBtnUI: function (state) {
            if (!currentActiveBtn) return;
            if (state === 'loading') {
                currentActiveBtn.innerHTML = '<span class="loading loading-spinner loading-xs text-[#9e1c26]"></span>';
            } else if (state === 'playing') {
                currentActiveBtn.innerHTML = '<i class="fa-solid fa-stop-circle text-[#9e1c26] animate-pulse"></i>';
            } else {
                // 还原图标，根据类型判断
                const isChat = currentActiveBtn.classList.contains('chat-tts-btn');
                currentActiveBtn.innerHTML = isChat ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-high fa-fw"></i>';
            }
        }
    };
})();

window.GuaLingTTS = GuaLingTTS;