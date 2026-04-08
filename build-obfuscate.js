const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const jsDir = './js';
const backupDir = './backup';

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

// 生成时间戳
const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

fs.readdirSync(jsDir).forEach(file => {
    if (file.endsWith('_ori.js')) {
        const baseName = file.replace('_ori.js', '');
        const targetFile = `${baseName}.js`;
        const targetPath = path.join(jsDir, targetFile);

        // 1. 如果存在旧的生产文件，先备份
        if (fs.existsSync(targetPath)) {
            const backupPath = path.join(backupDir, `${baseName}_${timestamp}.js`);
            fs.copyFileSync(targetPath, backupPath);
            console.log(`[备份] 已备份旧的生产文件: ${targetFile} -> ${path.basename(backupPath)}`);
        }

        // 2. 执行混淆
        const sourcePath = path.join(jsDir, file);
        const sourceCode = fs.readFileSync(sourcePath, 'utf8');

        console.log(`[混淆] 正在生成: ${targetFile}`);
        const result = JavaScriptObfuscator.obfuscate(sourceCode, {
            compact: true,
            controlFlowFlattening: true
        });

        fs.writeFileSync(targetPath, result.getObfuscatedCode(), 'utf8');
    }
});
console.log('✅ 混淆完成，旧版本已备份。');