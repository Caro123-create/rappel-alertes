#!/usr/bin/env node
// Rapport Telegram quotidien — Rappel Alertes
// Usage : node scripts/telegram-report.mjs [--dry-run] | --get-chat-id
// Env : TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (ou fichier .env.local, non versionné)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const GET_CHAT = args.includes('--get-chat-id');
const IND = 'indisponible';

// Charge .env.local sans écraser l'environnement existant
const envFile = path.join(ROOT, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const api = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

if (GET_CHAT) {
  if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN manquant.'); process.exit(1); }
  const r = await (await fetch(api('getUpdates'))).json();
  if (!r.ok) { console.error('Erreur Telegram :', r.description); process.exit(1); }
  const chats = new Map();
  for (const u of r.result) { const c = (u.message || u.channel_post || u.my_chat_member)?.chat; if (c) chats.set(c.id, c); }
  if (!chats.size) console.log('Aucun message reçu. Envoyez "bonjour" au bot puis relancez.');
  for (const c of chats.values()) console.log(`chat_id=${c.id}  (${c.type} ${c.first_name || c.title || ''} ${c.username ? '@' + c.username : ''})`);
  process.exit(0);
}

const now = new Date();
const since = new Date(now - 24 * 3600 * 1000);
const fmt = (d) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); } catch { return null; } };

// 1. Pages publiées / actualisées
const data = readJSON('data/rappels.json');
const records = data?.records || [];
const recent = records.filter((r) => r.verified_at && new Date(r.verified_at) >= since);
const newPubs = records.filter((r) => r.date_publication && new Date(r.date_publication) >= since);
let commits = [];
try {
  commits = execSync(`git log --since="24 hours ago" --pretty=format:"%h %s"`, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { commits = null; }

// 2. Visites / clics : uniquement si un fichier d'analytics existe
const analytics = readJSON('data/analytics.json'); // format attendu : { visits, clicks, period, source }
const visits = analytics?.visits ?? IND;
const clicks = analytics?.clicks ?? IND;

// 3. Commissions : fichier rempli par les connecteurs affiliés (absent = indisponible)
const comm = readJSON('data/commissions.json'); // format : [{ platform, amount, currency, status }]

// 4. Dépenses
const exp = readJSON('data/expenses.json'); // format : { total, currency, note }

// 5. Erreurs : logs/*.log des dernières 24 h
let errors = [];
const logDir = path.join(ROOT, 'logs');
if (fs.existsSync(logDir)) {
  for (const f of fs.readdirSync(logDir).filter((f) => f.endsWith('.log'))) {
    const p = path.join(logDir, f);
    if (fs.statSync(p).mtime < since) continue;
    for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (/error|erreur|fail|échec/i.test(l)) errors.push(`${f}: ${l.slice(0, 200)}`);
  }
}
const draftsDir = path.join(ROOT, 'drafts');
const drafts = fs.existsSync(draftsDir) ? fs.readdirSync(draftsDir).filter((f) => !f.startsWith('.')) : [];

const L = [];
L.push(`<b>📰 Rappel Alertes — rapport du ${esc(fmt(now))}</b> (Madrid)`);
L.push('');
L.push('<b>Pages</b>');
L.push(`• Fiches au total : ${records.length || IND}`);
L.push(`• Nouveaux rappels (publiés &lt; 24 h) : ${newPubs.length}`);
for (const r of newPubs.slice(0, 5)) L.push(`   – ${esc(r.libelle)} (${esc(r.marque_produit)})`);
L.push(`• Fiches vérifiées &lt; 24 h : ${recent.length}`);
L.push(`• Commits &lt; 24 h : ${commits === null ? IND : commits.length}`);
for (const c of (commits || []).slice(0, 5)) L.push(`   – ${esc(c)}`);
L.push('');
L.push('<b>Audience</b>');
L.push(`• Visites : ${esc(visits)}`);
L.push(`• Clics affiliés : ${esc(clicks)}`);
if (analytics?.source) L.push(`   (source : ${esc(analytics.source)})`);
L.push('');
L.push('<b>Commissions</b> (remontées plateformes, non encaissées sauf statut « payé »)');
if (Array.isArray(comm) && comm.length) for (const c of comm) L.push(`• ${esc(c.platform)} : ${esc(c.amount)} ${esc(c.currency || '€')} — ${esc(c.status)}`);
else L.push(`• ${IND}`);
L.push('');
L.push(`<b>Dépenses</b> : ${exp ? `${esc(exp.total)} ${esc(exp.currency || '€')}${exp.note ? ' — ' + esc(exp.note) : ''}` : `0 € (hébergement gratuit) / détail ${IND}`}`);
L.push('');
L.push('<b>Erreurs / à faire</b>');
if (!errors.length && !drafts.length) L.push('• Aucune erreur détectée');
for (const e of errors.slice(0, 8)) L.push(`• ⚠️ ${esc(e)}`);
if (drafts.length) L.push(`• ${drafts.length} brouillon(s) en attente de vérification`);

let msg = L.join('\n');
if (msg.length > 4000) msg = msg.slice(0, 3990) + '\n…';

if (DRY) { console.log(msg); process.exit(0); }
if (!TOKEN || !CHAT) { console.error('TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant (voir docs/telegram-setup.md).'); process.exit(2); }

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const r = await (await fetch(api('sendMessage'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    })).json();
    if (r.ok) { console.log('Rapport envoyé (message_id', r.result.message_id + ')'); process.exit(0); }
    console.error(`Tentative ${attempt} : ${r.description}`);
    if (r.error_code && r.error_code < 500 && r.error_code !== 429) break;
  } catch (e) { console.error(`Tentative ${attempt} : ${e.message}`); }
  await new Promise((s) => setTimeout(s, 5000 * attempt));
}
process.exit(1);
