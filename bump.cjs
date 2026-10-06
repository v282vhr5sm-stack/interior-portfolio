// 배포 전에 실행: node bump.cjs → 화면 파일 주소에 새 버전 번호를 붙여서 브라우저가 바로 새 파일을 받게 함
const fs = require('fs');
const v = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
for (const f of ['index.html', 'admin.html']) {
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/(styles\.css|config\.js|app\.js)(\?v=\d+)?"/g, `$1?v=${v}"`));
}
console.log('version', v);
