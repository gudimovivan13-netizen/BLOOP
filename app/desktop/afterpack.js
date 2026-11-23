/* afterPack: кладём серверный бандл, иконку и веб-клиент в resources
   упакованного приложения (electron-builder extraFiles не сработал для них). */
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const res = path.join(context.appOutDir, 'resources');
  for (const f of ['server-bundle.mjs', 'icon.ico']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(res, f));
  }
  fs.cpSync(path.join(__dirname, 'public'), path.join(res, 'public'), { recursive: true });
  const have = fs.readdirSync(res).join(', ');
  console.log(`afterPack: ресурсы -> [${have}]`);
};
