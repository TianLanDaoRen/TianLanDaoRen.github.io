(function () {
    const ApiBaseUrl = 'https://bzapi2.iwzbz.com/getbasebz7.php';

    // Dom元素
    let elements = null;

    // 清除所有错误提示
    function clearErrors() {
        document.querySelectorAll('.label-text-alt').forEach(alt => {
            alt.textContent = '';
        });
    }

    // 数据验证
    function validateForm() {
        let isValid = true;
        clearErrors();

        // 检查性别选择
        const gender = document.querySelector('.gender-group .btn-active');
        if (!gender) {
            document.querySelector('.gender-alt').textContent = '请选择性别';
            isValid = false;
        }

        // 检查出生日期
        const birth = document.querySelector('input[name="birth"]');
        let empty = birth.value.trim() === '';
        // 检查出生日期格式 yyyy-mm-dd hh:mm
        let regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
        if (empty || !regex.test(birth.value)) {
            document.querySelector('.birth-alt').textContent = '请正确输入出生日期';
            isValid = false;
        }

        return isValid;
    }

    // 收集表单数据
    function collectFormData() {
        const data = {
            gender: document.querySelector('.gender-group .btn-active').getAttribute('data-value'),
            birth: document.querySelector('input[name="birth"]').value.trim(),
        };

        return data;
    }

    // 处理起卦按钮点击事件
    async function handleCalculate() {
        // 禁用按钮
        elements.calculateBtn.disabled = true;

        // 验证表单
        if (!validateForm()) {
            // 启用按钮
            elements.calculateBtn.disabled = false;
            return;
        }

        // 收集数据
        const formData = collectFormData();

        // 显示加载动画
        elements.loadings.forEach(loading => loading.classList.remove('hidden'));
        elements.resultDivider.classList.remove('hidden');
        elements.resultPanel.classList.remove('hidden');

        try {
            elements.codeContent.innerHTML = JSON.stringify(formData);

            // 调用API获取卦象解释
            let timeout = new Promise((_, reject) => {
                setTimeout(() => {
                    reject('timeout');
                }, 10000);
            });
            try {
                await Promise.race([
                    baziPaipan(formData).then((result) => {
                        if (result !== null && result.trim() !== '') return;
                        elements.codeContent.innerHTML = '暂不可用，请检查网络连接或稍后再试！';
                    }),
                    timeout
                ]);
            } catch (error) {
                console.log(error);
            } finally {
                clearTimeout(timeout); // Stop
            }
        } catch (error) {
            console.error('Error:', error);
            elements.codeContent.innerHTML = JSON.stringify(error);
        } finally {
            // 隐藏加载动画
            elements.loadings.forEach(loading => loading.classList.add('hidden'));
            // 启用按钮
            elements.calculateBtn.disabled = false;
        }
    }

    async function baziPaipan(formData) {
        const url = `${ApiBaseUrl}?d=${formData.birth}&s=${formData.gender}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('网络错误');
        }
        const result = await response.json();
        // 解析结果到字符串
        const yearBaZi = result.bz["0"] + result.bz["1"];
        const monthBaZi = result.bz["2"] + result.bz["3"];
        const dayBaZi = result.bz["4"] + result.bz["5"];
        const hourBaZi = result.bz["6"] + result.bz["7"];
        console.log(yearBaZi, monthBaZi, dayBaZi, hourBaZi);

        const yearShiShen = result.ss[0];
        const monthShiShen = result.ss[1];
        const dayShiShen = result.ss[2];
        const hourShiShen = result.ss[3];
        console.log(yearShiShen, monthShiShen, dayShiShen, hourShiShen);

        const cangGan = result.cg;
        const cangGanShiShen = result.cgss;
        const cangGanList = cangGan.map((v, i) => v.map((vv, ii) => `${vv}(${cangGanShiShen[i][ii]})`));
        const yearCangGan = cangGanList[0].join('、');
        const monthCangGan = cangGanList[1].join('、');
        const dayCangGan = cangGanList[2].join('、');
        const hourCangGan = cangGanList[3].join('、');
        console.log(yearCangGan, monthCangGan, dayCangGan, hourCangGan);

        const yearNaYin = result.ny[0];
        const monthNaYin = result.ny[1];
        const dayNaYin = result.ny[2];
        const hourNaYin = result.ny[3];
        console.log(yearNaYin, monthNaYin, dayNaYin, hourNaYin);

        const yearDiShi = result.xy[0];
        const monthDiShi = result.xy[1];
        const dayDiShi = result.xy[2];
        const hourDiShi = result.xy[3];
        console.log(yearDiShi, monthDiShi, dayDiShi, hourDiShi);

        const yearZiZuo = result.zz[0];
        const monthZiZuo = result.zz[1];
        const dayZiZuo = result.zz[2];
        const hourZiZuo = result.zz[3];
        console.log(yearZiZuo, monthZiZuo, dayZiZuo, hourZiZuo);

        const yearKongWang = result.kw[0];
        const monthKongWang = result.kw[1];
        const dayKongWang = result.kw[2];
        const hourKongWang = result.kw[3];
        console.log(yearKongWang, monthKongWang, dayKongWang, hourKongWang);

        const yearShenSha = result.szshensha[0].join('、');
        const monthShenSha = result.szshensha[1].join('、');
        const dayShenSha = result.szshensha[2].join('、');
        const hourShenSha = result.szshensha[3].join('、');
        console.log(yearShenSha, monthShenSha, dayShenSha, hourShenSha);

        const taiXi = result.taixi + `(${result.taixi_nayin})`;
        const taiYuan = result.taiyuan + `(${result.taiyuan_nayin})`;
        const mingGong = result.minggong + `(${result.minggong_nayin})`;
        const shenGong = result.shenggong + `(${result.shenggong_nayin})`;
        const kongWang = result.kongwang;
        console.log(taiXi, taiYuan, mingGong, shenGong, kongWang);

        const qiYun = `出生后${result.qiyunarr[0]}年${result.qiyunarr[1]}个月${result.qiyunarr[2]}天${result.qiyunarr[3]}时起大运，每${result.jiaoyun}。`;
        console.log(qiYun);

        const year = parseInt(formData.birth.split(' ')[0].split('-')[0]);
        const dayunShenSha = result.dayun.map((v, i) => `${v}(${result.dyshensha[i][1].join('、')})`);
        const dayunNian = [];
        for (let i = 0; i < dayunShenSha.length; i++) {
            dayunNian.push(year + result.qiyunsui - 1 + i * 10);
        }
        const dayun = dayunNian.map((v, i) => `${v}：${dayunShenSha[i]}`).join("；");
        console.log(dayun);

        const resultStr =
            `八字排盘如下：年柱：[乾造：${yearBaZi}，十神：${yearShiShen}，藏干：${yearCangGan}，纳音：${yearNaYin}，地势（星运）：${yearDiShi}，自坐：${yearZiZuo}，空亡：${yearKongWang}，神煞：${yearShenSha}]；` +
            `月柱：[乾造：${monthBaZi}，十神：${monthShiShen}，藏干：${monthCangGan}，纳音：${monthNaYin}，地势（星运）：${monthDiShi}，自坐：${monthZiZuo}，空亡：${monthKongWang}，神煞：${monthShenSha}]；` +
            `日柱：[乾造：${dayBaZi}，十神：${dayShiShen}，藏干：${dayCangGan}，纳音：${dayNaYin}，地势（星运）：${dayDiShi}，自坐：${dayZiZuo}，空亡：${dayKongWang}，神煞：${dayShenSha}]；` +
            `时柱：[乾造：${hourBaZi}，十神：${hourShiShen}，藏干：${hourCangGan}，纳音：${hourNaYin}，地势（星运）：${hourDiShi}，自坐：${hourZiZuo}，空亡：${hourKongWang}，神煞：${hourShenSha}]。` +
            `胎息：${taiXi}，胎元：${taiYuan}，命宫：${mingGong}，身宫：${shenGong}，空亡：${kongWang}。${qiYun}大运：${dayun}。`;



        elements.codeContent.innerHTML = resultStr;
        return resultStr;
    }

    // 初始化
    document.addEventListener('DOMContentLoaded', () => {
        // 初始化Dom元素
        elements = {
            calculateBtn: document.querySelector('.calculate'),
            loadings: document.querySelectorAll('.loading'),
            resultDivider: document.querySelector('.result-divider'),
            resultPanel: document.querySelector('.result'),
            codeContent: document.querySelector('.code-content'),
            codeCopyBtn: document.querySelector('.code-copy-btn'),
        };
        // 绑定排盘按钮事件
        elements.calculateBtn.addEventListener('click', handleCalculate);
        elements.codeCopyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(elements.codeContent.textContent).then(() => {
                elements.codeCopyBtn.textContent = '已复制';
                setTimeout(() => {
                    elements.codeCopyBtn.textContent = '复制';
                }, 2000);
            });
        });
        // 绑定性别选择事件
        document.querySelectorAll('.gender-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // 移除所有激活状态
                document.querySelectorAll('.gender-btn').forEach(b => {
                    b.classList.remove('btn-active', 'btn-primary');
                    b.classList.add('btn-outline');
                });
                // 激活当前按钮
                const target = e.target;
                target.classList.add('btn-active', 'btn-primary');
                target.classList.remove('btn-outline');

                // 更新隐藏域
                document.querySelector('input[name="gender"]').value = target.getAttribute('data-value');
            });
        });
    });

    // 返回公共接口
})(); 