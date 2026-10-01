// Use Chrome's own CRX3 packer and retain the same key for subsequent releases.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, copyFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, 'dist/extension');
const key = resolve(root, 'signing/qingkong.pem');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const chrome = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')]
  .filter(Boolean).find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME_PATH to chrome.exe');
await mkdir(resolve(root, 'signing'), {recursive: true});
await mkdir(resolve(root, 'releases'), {recursive: true});
const generatedKey = extension + '.pem';
if (!existsSync(key) && existsSync(generatedKey)) await rename(generatedKey, key);
const args = [`--pack-extension=${extension}`, '--no-message-box', `--user-data-dir=${resolve(root, 'work/pack-profile')}`];
if (existsSync(key)) args.push(`--pack-extension-key=${key}`);
const result = spawnSync(chrome, args, {windowsHide: true, timeout: 60000, encoding: 'utf8'});
if (result.error || result.status !== 0) throw new Error('Chrome packaging failed; signing key retained');
if (!existsSync(key) && existsSync(generatedKey)) await rename(generatedKey, key);
if (!existsSync(key)) throw new Error('Signing key was not produced');
const bytes = await readFile(extension + '.crx');
if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'Cr24' || bytes.readUInt32LE(4) !== 3)
  throw new Error('Chrome did not produce a CRX3 package');
const filename = `qingkong-${manifest.version}.crx`;
await copyFile(extension + '.crx', resolve(root, 'releases', filename));
await writeFile(resolve(root, 'releases/安装说明.txt'),
  `晴空 · 订阅代理 ${manifest.version}\n\n${filename} 是 Chrome 签名的 CRX3 扩展包，与 iGuge 的 CRX 格式一致。\n\n安装：在 Chrome 打开 chrome://extensions，开启开发者模式，尝试将 CRX 拖入页面。Windows Chrome 可能禁止安装或启用非商店来源的 CRX；签名包本身不能绕过该限制。遇到来源限制时，请使用“加载已解压的扩展程序”，选择项目 dist/extension 目录。\n\n进入扩展设置，粘贴原 CLASH 订阅地址，选择自己的 HTTPS 浏览器节点并连接。无需插件登录。\n\n签名私钥保存在项目 signing/qingkong.pem，不在 CRX 中，不要发送给他人；后续版本应使用同一私钥打包。\n`, 'utf8');
console.log(`Created releases/${filename} (${bytes.length} bytes, CRX3). Signing key retained separately.`);
