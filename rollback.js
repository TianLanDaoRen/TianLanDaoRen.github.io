const fs = require('fs');
const path = require('path');

const jsDir = './js';
const backupDir = './backup';

const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.js'));
if (backups.length === 0) {
    console.error('❌ 没有找到任何备份文件！');
    process.exit(1);
}

// 1. 从所有备份文件名中提取所有时间戳，并去重排序
const timestamps = Array.from(new Set(backups.map(f => f.split('_').pop().replace('.js', ''))));
const latestTimestamp = timestamps.sort((a, b) => b - a)[0]; // 获取最新的时间戳

console.log(`🔄 正在回退到最新备份时间点: ${latestTimestamp}`);

// 2. 还原该时间戳对应的所有文件
backups.forEach(file => {
    if (file.endsWith(`_${latestTimestamp}.js`)) {
        // 还原文件名：去掉时间戳部分，例如 main_202604081025.js -> main.js
        const targetName = file.replace(`_${latestTimestamp}.js`, '.js');
        const targetPath = path.join(jsDir, targetName);
        const sourcePath = path.join(backupDir, file);

        fs.copyFileSync(sourcePath, targetPath);
        console.log(`[还原] ${file} -> ${targetName}`);
    }
});

console.log('✅ 回退成功！当前生产文件已恢复至之前的版本。');