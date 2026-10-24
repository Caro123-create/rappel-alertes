#!/usr/bin/env node
/**
 * Rappel Alertes — fetch RappelConso open data + generate static pages
 * Source: https://data.economie.gouv.fr (Licence Ouverte / Open Licence 2.0)
 * Dataset: rappelconso-v2-gtin-espaces
 *
 * MODE FILE D'ATTENTE (depuis le 24/10/2026, choix de Carole : 1 fiche / jour max)
 * - data/rappels.json = liste de TOUTES les fiches déjà publiées (jamais supprimées).
 *   Chaque fiche porte `published_at` (date de mise en ligne sur ce site).
 * - À chaque exécution : on récupère les FETCH_LIMIT rappels les plus récents de l'API,
 *   on écarte ceux déjà publiés et ceux aux champs essentiels incomplets, puis on
 *   publie au plus MAX_NEW (défaut 1) nouvelle(s) fiche(s).
 * - Priorité : 1) risque grave (listeria, salmonelle, E. coli, botulisme, blessure,
 *   brûlure, électrocution, incendie, étouffement…), 2) date de publication la plus récente.
 * - Garde-fou : si une fiche a déjà été publiée le même jour UTC (published_at),
 *   rien n'est ajouté (un lancement manuel ou double ne dépasse pas la limite).
 * - Les fiches publiées gardent leurs données stockées ; index, catégories, sitemap
 *   sont régénérés de façon déterministe (pas de diff les jours sans nouvelle fiche).
 * Variables d'env : MAX_NEW (défaut 1), DRY_RUN=1 (n'écrit rien, affiche la file),
 *   RA_NOW (ISO, pour tests uniquement : simule la date courante).
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/rappelconso-v2-gtin-espaces/records";
const FETCH_LIMIT = 100; // fenêtre de candidats (rappels les plus récents de l'API)
const QUEUE_MAX_AGE_DAYS = 30; // on ne publie pas un rappel de plus de 30 jours
const MAX_NEW = Math.max(0, parseInt(process.env.MAX_NEW ?? "1", 10) || 0);
const DRY_RUN = process.env.DRY_RUN === "1";
const NOW = process.env.RA_NOW ? new Date(process.env.RA_NOW) : new Date();
const SEVERE_RE =
  /listeria|salmonell|e\.?\s?coli|stec|botuli|clostridium|bless|br[uû]lure|[ée]lectrocution|[ée]lectrisation|incendie|[ée]touffement|suffocation|asphyxi|intoxication|coupure/i;
const SITE_NAME = "Rappel Alertes";
const SITE_TAGLINE = "Alertes de rappels produits — sources officielles";
const SITE_BASE = "/rappel-alertes"; // GitHub Pages project site

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugify(s) {
  return String(s ?? "autre")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "autre";
}

function fmtDateFR(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

function fmtDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
}

function pickImage(liens) {
  if (!liens) return null;
  const first = String(liens).split("|")[0].trim();
  return first.startsWith("http") ? first : null;
}

function splitPipes(s) {
  if (!s) return [];
  return String(s)
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}


function loadAffiliateConfig() {
  const p = join(ROOT, "data/affiliate.json");
  if (!existsSync(p)) {
    return {
      disclosure_fr: "Liens commerciaux : certains liens sont affiliés (Amazon Partenaires / Awin).",
      disclosure_footer_fr: "Certaines pages contiennent des liens d’affiliation.",
      amazon: { enabled: false, amazon_tag: "rappelalertes-21" },
      awin: { enabled: false },
    };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function affiliateAnyEnabled(cfg) {
  return Boolean(cfg?.amazon?.enabled || cfg?.awin?.enabled);
}

function amazonSearchKeyword(r) {
  const marque = String(r.marque_produit || "").trim();
  const lib = String(r.libelle || "").trim();
  const parts = [];
  if (marque && !/^sans\s*marque$/i.test(marque) && marque.toLowerCase() !== lib.toLowerCase()) {
    parts.push(marque);
  }
  if (lib) parts.push(lib);
  let kw = parts.join(" ").replace(/\s+/g, " ").trim();
  if (kw.length > 120) kw = kw.slice(0, 120).trim();
  return kw;
}

function amazonBlocked(r, cfg) {
  const catRe = new RegExp(cfg.amazon?.block_category_regex || "m[eé]dicament", "i");
  const textRe = new RegExp(cfg.amazon?.block_text_regex || "m[eé]dicament", "i");
  const blobCat = `${r.categorie_produit || ""} ${r.sous_categorie_produit || ""}`;
  const blobText = `${r.libelle || ""} ${r.motif_rappel || ""} ${r.risques_encourus || ""}`;
  return catRe.test(blobCat) || textRe.test(blobText);
}

function shouldShowAmazonCta(r, cfg) {
  if (!cfg?.amazon?.enabled) return false;
  if (!cfg.amazon.amazon_tag) return false;
  if (amazonBlocked(r, cfg)) return false;
  return Boolean(amazonSearchKeyword(r));
}

function amazonSearchUrl(r, cfg) {
  const tag = cfg.amazon.amazon_tag;
  const kw = amazonSearchKeyword(r);
  return `https://www.amazon.fr/s?k=${encodeURIComponent(kw)}&tag=${encodeURIComponent(tag)}`;
}

function affiliateAsideHtml(r, cfg) {
  if (!shouldShowAmazonCta(r, cfg)) return "";
  const url = amazonSearchUrl(r, cfg);
  const label = cfg.amazon.cta_label_fr || "Voir un produit de remplacement sur Amazon";
  const disclosure = cfg.disclosure_fr || "Liens commerciaux : certains liens sont affiliés (Amazon Partenaires / Awin).";
  return `
          <div class="box commercial">
            <h2>Remplacement (lien commercial)</h2>
            <p class="commercial-note">Suggestion d’achat optionnelle, distincte de la fiche officielle. Ce n’est pas un conseil médical ni une consigne de rappel.</p>
            <p><a class="btn btn-amazon" href="${esc(url)}" rel="sponsored noopener noreferrer" target="_blank">${esc(label)}</a></p>
            <p class="disclosure-affiliate">${esc(disclosure)}</p>
          </div>`;
}

function footerAffiliateHtml(cfg) {
  if (!affiliateAnyEnabled(cfg)) return "";
  const line = cfg.disclosure_footer_fr || cfg.disclosure_fr || "";
  return `\n      <p class="disclosure-affiliate">${esc(line)}</p>`;
}

function normalizeRecord(raw, verifiedAt) {
  const id = raw.id ?? raw.rappel_guid;
  const sourceUrl =
    raw.lien_vers_la_fiche_rappel ||
    (id ? `https://rappel.conso.gouv.fr/fiche-rappel/${id}/interne` : null);
  return {
    id: String(id),
    rappel_guid: raw.rappel_guid || null,
    numero_fiche: raw.numero_fiche || null,
    libelle: raw.libelle || raw.modeles_ou_references || "Produit rappelé",
    marque_produit: raw.marque_produit || null,
    modeles_ou_references: raw.modeles_ou_references || null,
    categorie_produit: (raw.categorie_produit || "autres").trim(),
    sous_categorie_produit: raw.sous_categorie_produit || null,
    motif_rappel: raw.motif_rappel || null,
    risques_encourus: raw.risques_encourus || null,
    preconisations_sanitaires: raw.preconisations_sanitaires || null,
    conduites_a_tenir: splitPipes(raw.conduites_a_tenir_par_le_consommateur),
    distributeurs: raw.distributeurs || null,
    zone_geographique_de_vente: raw.zone_geographique_de_vente || null,
    modalites_de_compensation: raw.modalites_de_compensation || null,
    date_publication: raw.date_publication || null,
    date_de_fin_de_la_procedure_de_rappel:
      raw.date_de_fin_de_la_procedure_de_rappel || null,
    lien_officiel: sourceUrl,
    lien_affichette: raw.lien_vers_affichette_pdf || null,
    image: pickImage(raw.liens_vers_les_images),
    nature_juridique_rappel: raw.nature_juridique_rappel || null,
    source_url: sourceUrl,
    verified_at: verifiedAt,
  };
}

async function fetchApi(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "RappelAlertes/0.1 (Mogul; open-data reuse)" },
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchByIds(ids) {
  if (!ids.length) return [];
  const where = encodeURIComponent(`id in (${ids.map((i) => Number(i)).join(",")})`);
  const data = await fetchApi(`${API}?where=${where}&limit=100`);
  return data.results || [];
}

async function fetchRecent() {
  const url = `${API}?limit=${FETCH_LIMIT}&order_by=date_publication%20desc`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "RappelAlertes/0.1 (Mogul; open-data reuse)" },
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { total: data.total_count, results: data.results || [] };
}

function layout({ title, description, canonicalPath, body, active, affiliateCfg }) {
  const pageTitle = title.includes(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
  const desc = description || SITE_TAGLINE;
  const canon = canonicalPath || "/";
  const affFoot = footerAffiliateHtml(affiliateCfg || {});
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index,follow">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="fr_FR">
  <meta property="og:title" content="${esc(pageTitle)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta name="theme-color" content="#1a2332">
  <link rel="stylesheet" href="${SITE_BASE}/assets/css/site.css">
  <!-- Analytics respectueux de la vie privée (Plausible / Cloudflare Web Analytics) — non actif pour l'instant -->
</head>
<body>
  <a class="skip" href="#contenu">Aller au contenu</a>
  <header class="site-header">
    <div class="wrap header-inner">
      <a class="brand" href="${SITE_BASE}/index.html">
        <span class="brand-mark" aria-hidden="true">⚠</span>
        <span class="brand-text">
          <strong>${esc(SITE_NAME)}</strong>
          <em>France · open data</em>
        </span>
      </a>
      <nav class="nav" aria-label="Principale">
        <a href="${SITE_BASE}/index.html" class="${active === "home" ? "is-active" : ""}">Accueil</a>
        <a href="${SITE_BASE}/categories/index.html" class="${active === "cats" ? "is-active" : ""}">Catégories</a>
        <a href="${SITE_BASE}/a-propos.html" class="${active === "about" ? "is-active" : ""}">À propos</a>
      </nav>
    </div>
  </header>
  <main id="contenu" class="wrap">
${body}
  </main>
  <footer class="site-footer">
    <div class="wrap footer-inner">
      <p><strong>${esc(SITE_NAME)}</strong> réutilise les données publiques de
        <a href="https://rappel.conso.gouv.fr/" rel="noopener">RappelConso</a>
        (DGCCRF / DGAL / DGEC / DGPR), publiées sous
        <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/" rel="noopener">Licence Ouverte 2.0</a>.</p>
      <p class="muted">Ce site n’est pas un service officiel de l’État. Vérifiez toujours la fiche source. Projet indépendant — sans lien avec Elena Reign.</p>${affFoot}
      <p class="muted"><a href="${SITE_BASE}/a-propos.html">Mentions &amp; sources</a></p>
    </div>
  </footer>
  <script src="${SITE_BASE}/assets/js/search.js" defer></script>
</body>
</html>
`;
}

function cardHtml(r, prefix = "") {
  const href = `${prefix}fiches/${esc(r.id)}.html`;
  const img = r.image
    ? `<img src="${esc(r.image)}" alt="" loading="eager" decoding="async" referrerpolicy="no-referrer" width="120" height="120">`
    : `<div class="card-ph" aria-hidden="true">📦</div>`;
  return `<article class="card">
  <a class="card-media" href="${href}">${img}</a>
  <div class="card-body">
    <p class="meta"><span class="pill">${esc(r.categorie_produit)}</span> <time datetime="${esc(r.date_publication || "")}">${esc(fmtDateShort(r.date_publication))}</time></p>
    <h3><a href="${href}">${esc(r.libelle)}</a></h3>
    <p class="marque">${esc(r.marque_produit || "Marque non indiquée")}</p>
    <p class="motif">${esc((r.motif_rappel || r.risques_encourus || "").slice(0, 140))}</p>
  </div>
</article>`;
}

function ficheHtml(r, affiliateCfg) {
  const conduites = r.conduites_a_tenir.length
    ? `<ul>${r.conduites_a_tenir.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
    : "<p>Voir la fiche officielle.</p>";
  const img = r.image
    ? `<figure class="fiche-img"><img src="${esc(r.image)}" alt="Illustration du produit rappelé" loading="lazy" referrerpolicy="no-referrer"></figure>`
    : "";
  const commercial = affiliateAsideHtml(r, affiliateCfg || {});
  const pageDisclosure = shouldShowAmazonCta(r, affiliateCfg || {})
    ? `<p class="disclosure-affiliate">${esc((affiliateCfg || {}).disclosure_fr || "")}</p>`
    : "";
  const body = `
    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="../index.html">Accueil</a> /
      <a href="../categories/${esc(slugify(r.categorie_produit))}.html">${esc(r.categorie_produit)}</a> /
      <span>${esc(r.libelle)}</span>
    </nav>
    <article class="fiche">
      <header class="fiche-head">
        <p class="meta"><span class="pill danger">Rappel</span>
          <time datetime="${esc(r.date_publication || "")}">Publié le ${esc(fmtDateFR(r.date_publication))}</time>
        </p>
        <h1>${esc(r.libelle)}</h1>
        <p class="lead">${esc(r.marque_produit || "Marque non indiquée")}${r.modeles_ou_references ? " · " + esc(r.modeles_ou_references) : ""}</p>
      </header>
      <div class="fiche-grid">
        <div>
          ${img}
          <section>
            <h2>Risque</h2>
            <p>${esc(r.risques_encourus || "Non précisé dans l’open data")}</p>
            ${r.motif_rappel ? `<p><strong>Motif :</strong> ${esc(r.motif_rappel)}</p>` : ""}
            ${r.preconisations_sanitaires ? `<p>${esc(r.preconisations_sanitaires)}</p>` : ""}
          </section>
          <section>
            <h2>Conduite à tenir</h2>
            ${conduites}
            ${r.modalites_de_compensation ? `<p><strong>Compensation :</strong> ${esc(r.modalites_de_compensation)}</p>` : ""}
          </section>
          ${r.distributeurs ? `<section><h2>Distributeurs</h2><p>${esc(r.distributeurs)}</p></section>` : ""}
          ${r.zone_geographique_de_vente ? `<section><h2>Zone de vente</h2><p>${esc(r.zone_geographique_de_vente)}</p></section>` : ""}
        </div>
        <aside class="fiche-aside">
          <div class="box official">
            <h2>Source officielle</h2>
            <p>Toujours vérifier sur RappelConso avant d’agir.</p>
            <p><a class="btn" href="${esc(r.lien_officiel)}" rel="noopener noreferrer" target="_blank">Ouvrir la fiche RappelConso</a></p>
            ${r.lien_affichette ? `<p><a href="${esc(r.lien_affichette)}" rel="noopener noreferrer" target="_blank">Affichette PDF</a></p>` : ""}
          </div>
          ${commercial}
          <dl class="facts">
            <div><dt>N° fiche</dt><dd>${esc(r.numero_fiche || r.id)}</dd></div>
            <div><dt>Catégorie</dt><dd>${esc(r.categorie_produit)}</dd></div>
            ${r.sous_categorie_produit ? `<div><dt>Sous-catégorie</dt><dd>${esc(r.sous_categorie_produit)}</dd></div>` : ""}
            <div><dt>Publication API</dt><dd><time datetime="${esc(r.date_publication || "")}">${esc(fmtDateFR(r.date_publication))}</time></dd></div>
            <div><dt>Vérifié par Mogul</dt><dd><time datetime="${esc(r.verified_at)}">${esc(fmtDateFR(r.verified_at))}</time></dd></div>
            ${r.date_de_fin_de_la_procedure_de_rappel ? `<div><dt>Fin de procédure</dt><dd>${esc(fmtDateFR(r.date_de_fin_de_la_procedure_de_rappel))}</dd></div>` : ""}
          </dl>
        </aside>
      </div>
      <p class="disclaimer">Informations issues de l’open data RappelConso. Aucune donnée inventée. En cas de doute, suivez exclusivement les consignes de la fiche officielle.</p>
      ${pageDisclosure}
    </article>`;
  return layout({
    title: `Rappel : ${r.libelle}`,
    description: `Rappel produit ${r.marque_produit || ""} — ${r.motif_rappel || r.risques_encourus || "voir fiche officielle"}`.slice(0, 160),
    canonicalPath: `/fiches/${r.id}.html`,
    body,
    active: "",
    affiliateCfg,
  });
}

function indexHtml(records, cats, affiliateCfg) {
  const cards = records.map((r) => cardHtml(r)).join("\n");
  const catLinks = cats
    .map(
      (c) =>
        `<a class="cat-chip" href="categories/${esc(c.slug)}.html">${esc(c.name)} <span>${c.count}</span></a>`
    )
    .join("\n");
  const body = `
    <section class="hero">
      <h1>Rappels produits récents</h1>
      <p class="lead">Un annuaire clair des rappels publiés sur <strong>RappelConso</strong>. Données publiques officielles, lien source sur chaque fiche, date de vérification affichée.</p>
      <form class="search" role="search" id="search-form" action="#" method="get">
        <label class="sr-only" for="q">Rechercher une marque ou un produit</label>
        <input id="q" name="q" type="search" placeholder="Marque, produit, motif…" autocomplete="off">
        <button type="submit">Rechercher</button>
      </form>
      <p class="disclaimer hero-note">Information publique officielle — ce site n’est pas affilié à l’État. Vérifiez toujours le <a href="https://rappel.conso.gouv.fr/" rel="noopener">lien RappelConso</a>.</p>
    </section>
    <section>
      <h2>Catégories</h2>
      <div class="cat-row">${catLinks}</div>
    </section>
    <section>
      <div class="section-head">
        <h2>Derniers rappels</h2>
        <p class="muted">${records.length} fiches vérifiées · tri par date de publication</p>
      </div>
      <div class="cards" id="results">${cards}</div>
      <p id="no-results" class="muted" hidden>Aucun rappel ne correspond à cette recherche.</p>
    </section>`;
  return layout({
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_TAGLINE,
    canonicalPath: "/",
    body,
    active: "home",
    affiliateCfg,
  });
}

function categoryIndexHtml(cats, affiliateCfg) {
  const list = cats
    .map(
      (c) =>
        `<li><a href="${esc(c.slug)}.html"><strong>${esc(c.name)}</strong> <span>${c.count} fiche${c.count > 1 ? "s" : ""}</span></a></li>`
    )
    .join("\n");
  const body = `
    <header class="page-head">
      <h1>Catégories</h1>
      <p class="lead">Regroupement d’après le champ officiel <code>categorie_produit</code>.</p>
    </header>
    <ul class="cat-list">${list}</ul>`;
  return layout({
    title: "Catégories",
    description: "Parcourir les rappels par catégorie produit",
    canonicalPath: "/categories/",
    body,
    active: "cats",
    affiliateCfg,
  });
}

function categoryPageHtml(cat, records, affiliateCfg) {
  const cards = records.map((r) => cardHtml(r, "../")).join("\n");
  const body = `
    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="../index.html">Accueil</a> / <a href="index.html">Catégories</a> / <span>${esc(cat.name)}</span>
    </nav>
    <header class="page-head">
      <h1>${esc(cat.name)}</h1>
      <p class="muted">${records.length} rappel${records.length > 1 ? "s" : ""} publié${records.length > 1 ? "s" : ""} sur ce site</p>
    </header>
    <div class="cards">${cards}</div>`;
  return layout({
    title: `Catégorie : ${cat.name}`,
    description: `Rappels produits — ${cat.name}`,
    canonicalPath: `/categories/${cat.slug}.html`,
    body,
    active: "cats",
    affiliateCfg,
  });
}

function aboutHtml(meta, affiliateCfg) {
  const body = `
    <header class="page-head">
      <h1>À propos</h1>
    </header>
    <article class="prose">
      <p><strong>Rappel Alertes</strong> est un petit site utilitaire qui met en forme les rappels de produits publiés sur le portail gouvernemental RappelConso. Il est géré par l’agent <strong>Mogul</strong> pour Carole. Projet indépendant, sans lien avec l’activité d’autrice Elena Reign.</p>
      <h2>Sources</h2>
      <ul>
        <li>Jeu de données <a href="https://data.economie.gouv.fr/explore/dataset/rappelconso-v2-gtin-espaces/" rel="noopener">rappelconso-v2-gtin-espaces</a> (data.economie.gouv.fr)</li>
        <li>Site public <a href="https://rappel.conso.gouv.fr/" rel="noopener">rappel.conso.gouv.fr</a></li>
        <li>Licence : <a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/" rel="noopener">Licence Ouverte 2.0</a></li>
      </ul>
      <h2>Méthode</h2>
      <p>Chaque fiche affiche le lien officiel, la date de publication de l’API et la date de vérification Mogul (<code>verified_at</code>). Aucune information n’est inventée : seuls les champs de l’open data sont repris.</p>
      <p>Dernière génération : <time datetime="${esc(meta.generated_at)}">${esc(fmtDateFR(meta.generated_at))}</time> · ${meta.fiche_count} fiches · total API connu : ${meta.api_total_count}</p>
      <h2>Liens commerciaux / affiliation</h2>
      <p>Certaines fiches peuvent proposer un lien vers un <strong>produit de remplacement</strong> sur Amazon.fr (programme Amazon Partenaires). Ces liens sont <strong>commerciaux</strong> : si vous achetez via ces liens, Rappel Alertes peut percevoir une commission, sans surcoût pour vous.</p>
      <p class="disclosure-affiliate">${esc((affiliateCfg || {}).disclosure_fr || "Liens commerciaux : certains liens sont affiliés (Amazon Partenaires / Awin).")}</p>
      <p>Le lien officiel RappelConso reste toujours prioritaire et n’est jamais remplacé. Les données de rappel ne sont pas sponsorisées. Awin pourra être utilisé plus tard pour d’autres enseignes (non actif pour l’instant).</p>
      <h2>Contact</h2>
      <p>Contact à définir (placeholder). Pour une urgence sanitaire, suivez les consignes de la fiche RappelConso et contactez un professionnel de santé si besoin.</p>
      <h2>Vie privée</h2>
      <p>Aucun cookie de suivi n’est actif. Un analytics respectueux (Plausible ou Cloudflare Web Analytics) pourra être branché plus tard — placeholder seulement pour l’instant.</p>
    </article>`;
  return layout({
    title: "À propos",
    description: "Sources Licence Ouverte et méthode de Rappel Alertes",
    canonicalPath: "/a-propos.html",
    body,
    active: "about",
    affiliateCfg,
  });
}

function writeCss() {
  const css = `/* Rappel Alertes — sober utility UI */
:root {
  --bg: #f4f1ea;
  --bg-elev: #fffdf8;
  --ink: #1a2332;
  --muted: #5c6573;
  --line: #d9d2c5;
  --accent: #c45c26;
  --accent-ink: #8a3a12;
  --danger: #9b2c2c;
  --ok: #2f5d50;
  --radius: 14px;
  --shadow: 0 10px 30px rgba(26, 35, 50, 0.08);
  --font: "Source Sans 3", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--font);
  color: var(--ink);
  background:
    radial-gradient(1200px 500px at 10% -10%, #f7e3d2 0%, transparent 55%),
    radial-gradient(900px 400px at 100% 0%, #dde7e2 0%, transparent 50%),
    var(--bg);
  line-height: 1.55;
  min-height: 100vh;
}
img { max-width: 100%; height: auto; display: block; }
a { color: var(--accent-ink); }
a:hover { color: var(--accent); }
.wrap { width: min(1080px, calc(100% - 2rem)); margin-inline: auto; }
.skip {
  position: absolute; left: -999px; top: 0; background: var(--ink); color: #fff; padding: .5rem 1rem; z-index: 10;
}
.skip:focus { left: 1rem; top: 1rem; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;
}
.site-header {
  position: sticky; top: 0; z-index: 5;
  backdrop-filter: blur(10px);
  background: rgba(244, 241, 234, 0.88);
  border-bottom: 1px solid var(--line);
}
.header-inner {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: .85rem 0;
}
.brand { display: flex; gap: .75rem; align-items: center; text-decoration: none; color: inherit; }
.brand-mark {
  width: 2.4rem; height: 2.4rem; border-radius: 12px;
  display: grid; place-items: center;
  background: linear-gradient(145deg, #e8a06a, #c45c26);
  color: #fff; font-size: 1.1rem; box-shadow: var(--shadow);
}
.brand-text { display: flex; flex-direction: column; line-height: 1.15; }
.brand-text strong { font-size: 1.05rem; letter-spacing: -0.02em; }
.brand-text em { font-style: normal; color: var(--muted); font-size: .78rem; }
.nav { display: flex; gap: .35rem; flex-wrap: wrap; }
.nav a {
  text-decoration: none; color: var(--muted); padding: .4rem .75rem; border-radius: 999px; font-weight: 600; font-size: .92rem;
}
.nav a:hover, .nav a.is-active { background: #fff; color: var(--ink); box-shadow: 0 1px 0 var(--line); }
main.wrap { padding: 1.5rem 0 3rem; }
.hero {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 4px);
  padding: 1.5rem 1.35rem;
  box-shadow: var(--shadow);
  margin-bottom: 1.75rem;
}
.hero h1, .page-head h1, .fiche-head h1 {
  margin: 0 0 .5rem; font-size: clamp(1.6rem, 3vw, 2.2rem); letter-spacing: -0.03em; line-height: 1.15;
}
.lead { font-size: 1.05rem; color: var(--muted); margin: 0 0 1rem; max-width: 52ch; }
.search { display: flex; gap: .5rem; flex-wrap: wrap; margin: 1rem 0; }
.search input {
  flex: 1 1 220px; min-height: 2.75rem; border: 1px solid var(--line); border-radius: 12px;
  padding: .65rem .9rem; font: inherit; background: #fff;
}
.search button, .btn {
  appearance: none; border: 0; border-radius: 12px; min-height: 2.75rem; padding: .65rem 1.1rem;
  background: var(--ink); color: #fff; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center;
}
.search button:hover, .btn:hover { background: #2a3648; color: #fff; }
.btn { background: var(--accent); }
.btn:hover { background: var(--accent-ink); }
.disclaimer, .hero-note {
  font-size: .9rem; color: var(--muted); border-left: 3px solid var(--accent); padding-left: .75rem; margin: 1rem 0 0;
}
.section-head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
.muted { color: var(--muted); }
.cat-row { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0 1.5rem; }
.cat-chip {
  text-decoration: none; background: #fff; border: 1px solid var(--line); color: var(--ink);
  border-radius: 999px; padding: .4rem .8rem; font-size: .9rem; font-weight: 600;
}
.cat-chip span { color: var(--muted); font-weight: 500; margin-left: .25rem; }
.cards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem;
}
.card {
  background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden; display: grid; grid-template-columns: 104px 1fr; min-height: 132px;
  box-shadow: 0 4px 14px rgba(26,35,50,.04);
}
.card-media { background: #ebe4d8; display: grid; place-items: center; text-decoration: none; position: relative; min-height: 104px; overflow: hidden; }
.card-media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.card-ph { font-size: 1.8rem; opacity: .7; }
.card-body { padding: .85rem .9rem; }
.card h3 { margin: .2rem 0 .25rem; font-size: 1rem; line-height: 1.3; }
.card h3 a { color: inherit; text-decoration: none; }
.card h3 a:hover { color: var(--accent); }
.marque { margin: 0; font-weight: 600; font-size: .9rem; }
.motif { margin: .35rem 0 0; color: var(--muted); font-size: .86rem; }
.meta { margin: 0; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; font-size: .8rem; color: var(--muted); }
.pill {
  display: inline-block; background: #e8efe9; color: var(--ok); border-radius: 999px;
  padding: .15rem .55rem; font-weight: 700; text-transform: lowercase; font-size: .75rem;
}
.pill.danger { background: #f3dede; color: var(--danger); }
.breadcrumb { font-size: .9rem; color: var(--muted); margin-bottom: 1rem; }
.breadcrumb a { color: inherit; }
.fiche, .prose {
  background: var(--bg-elev); border: 1px solid var(--line); border-radius: calc(var(--radius) + 2px);
  padding: 1.25rem; box-shadow: var(--shadow);
}
.fiche-grid { display: grid; gap: 1.25rem; }
@media (min-width: 860px) {
  .fiche-grid { grid-template-columns: 1.4fr .8fr; align-items: start; }
}
.fiche-img { margin: 0 0 1rem; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); background: #ebe4d8; }
.fiche-img img { width: 100%; max-height: 320px; object-fit: contain; background: #fff; }
.fiche h2, .prose h2 { font-size: 1.05rem; margin: 1.2rem 0 .4rem; letter-spacing: -0.01em; }
.box.official {
  background: #1a2332; color: #f4f1ea; border-radius: 14px; padding: 1rem 1.1rem; margin-bottom: 1rem;
}
.box.official a { color: #f0c9a8; }
.box.official .btn { background: var(--accent); color: #fff; }
.box.commercial {
  background: #fffdf8; color: var(--ink); border: 1px dashed var(--line);
  border-radius: 14px; padding: 1rem 1.1rem; margin-bottom: 1rem;
}
.box.commercial h2 { margin-top: 0; font-size: 1rem; }
.commercial-note { font-size: .88rem; color: var(--muted); margin: 0 0 .75rem; }
.btn-amazon {
  background: #2f5d50; color: #fff !important; font-size: .92rem;
}
.btn-amazon:hover { background: #244a40; color: #fff !important; }
.disclosure-affiliate {
  font-size: .85rem; color: var(--muted);
  border-left: 3px solid #c4a574; padding-left: .75rem; margin: .75rem 0 0;
}
.facts { margin: 0; display: grid; gap: .65rem; }
.facts > div { border-top: 1px solid var(--line); padding-top: .55rem; }
.facts dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.facts dd { margin: .1rem 0 0; font-weight: 600; }
.cat-list { list-style: none; padding: 0; margin: 0; display: grid; gap: .5rem; }
.cat-list a {
  display: flex; justify-content: space-between; gap: 1rem; text-decoration: none; color: inherit;
  background: var(--bg-elev); border: 1px solid var(--line); border-radius: 12px; padding: .9rem 1rem;
}
.cat-list a:hover { border-color: var(--accent); }
.site-footer {
  border-top: 1px solid var(--line); padding: 1.5rem 0 2.5rem; color: var(--muted); font-size: .9rem;
}
.footer-inner p { margin: 0 0 .6rem; max-width: 70ch; }
code { font-family: var(--mono); font-size: .88em; background: #ebe4d8; padding: .1rem .35rem; border-radius: 4px; }
@media (max-width: 640px) {
  .card { grid-template-columns: 88px 1fr; }
  .header-inner { flex-direction: column; align-items: flex-start; }
}
`;
  writeFileSync(join(ROOT, "assets/css/site.css"), css);
}

function writeSearchJs() {
  const js = `(() => {
  const input = document.getElementById("q");
  const form = document.getElementById("search-form");
  const results = document.getElementById("results");
  const empty = document.getElementById("no-results");
  if (!input || !results) return;
  const cards = [...results.querySelectorAll(".card")];
  function filter() {
    const q = input.value.trim().toLowerCase();
    let n = 0;
    for (const card of cards) {
      const text = card.textContent.toLowerCase();
      const ok = !q || text.includes(q);
      card.hidden = !ok;
      if (ok) n++;
    }
    if (empty) empty.hidden = n > 0;
  }
  input.addEventListener("input", filter);
  form?.addEventListener("submit", (e) => { e.preventDefault(); filter(); });
  const params = new URLSearchParams(location.search);
  if (params.get("q")) { input.value = params.get("q"); filter(); }
})();`;
  writeFileSync(join(ROOT, "assets/js/search.js"), js);
}

// Champs essentiels pour publier une fiche utile (sinon le rappel reste hors file).
function isComplete(raw, rec) {
  return Boolean(
    rec.id &&
      rec.lien_officiel &&
      raw.libelle &&
      raw.categorie_produit &&
      rec.date_publication &&
      (rec.risques_encourus || rec.motif_rappel) &&
      rec.conduites_a_tenir.length
  );
}

function isSevere(r) {
  return SEVERE_RE.test(`${r.risques_encourus || ""} ${r.motif_rappel || ""}`);
}

function byDateDesc(a, b) {
  return String(b.date_publication).localeCompare(String(a.date_publication));
}

function loadPublished() {
  const p = join(ROOT, "data/rappels.json");
  if (!existsSync(p)) return { meta: null, records: [] };
  const meta = JSON.parse(readFileSync(p, "utf8"));
  return { meta, records: meta.records || [] };
}

async function main() {
  for (const d of ["data", "fiches", "categories", "assets/css", "assets/js"]) {
    mkdirSync(join(ROOT, d), { recursive: true });
  }

  const nowIso = NOW.toISOString();
  const todayUtc = nowIso.slice(0, 10);
  const affiliateCfg = loadAffiliateConfig();
  console.log(`Fetching RappelConso… (MAX_NEW=${MAX_NEW}${DRY_RUN ? ", DRY_RUN" : ""})`);
  console.log("Affiliate amazon:", affiliateCfg?.amazon?.enabled, "tag:", affiliateCfg?.amazon?.amazon_tag);

  const { meta: oldMeta, records: published } = loadPublished();
  const publishedIds = new Set(published.map((r) => String(r.id)));

  // Fiches HTML déjà en ligne mais absentes du JSON : on les réintègre depuis l'API
  // (on ne supprime jamais une fiche en ligne).
  const orphanIds = readdirSync(join(ROOT, "fiches"))
    .filter((f) => /^\d+\.html$/.test(f))
    .map((f) => f.replace(/\.html$/, ""))
    .filter((id) => !publishedIds.has(id));
  if (orphanIds.length) {
    const raws = await fetchByIds(orphanIds);
    for (const raw of raws) {
      const rec = normalizeRecord(raw, nowIso);
      if (publishedIds.has(rec.id)) continue;
      rec.published_at = null; // date de mise en ligne inconnue (fiche héritée)
      published.push(rec);
      publishedIds.add(rec.id);
    }
    console.log(`Fiches orphelines réintégrées : ${raws.length}/${orphanIds.length}`);
  }

  const { total, results } = await fetchRecent();
  const minDate = new Date(NOW.getTime() - QUEUE_MAX_AGE_DAYS * 86400e3).toISOString();
  const seen = new Set();
  const queue = [];
  let incomplete = 0;
  for (const raw of results) {
    const rec = normalizeRecord(raw, nowIso);
    if (!rec.id || seen.has(rec.id) || publishedIds.has(rec.id)) continue;
    seen.add(rec.id);
    if (!isComplete(raw, rec)) { incomplete += 1; continue; }
    if (String(rec.date_publication) < minDate) continue;
    queue.push(rec);
  }
  queue.sort((a, b) => (isSevere(b) - isSevere(a)) || byDateDesc(a, b));

  const publishedToday = published.filter((r) => String(r.published_at || "").slice(0, 10) === todayUtc);
  const allowance = Math.max(0, MAX_NEW - publishedToday.length);
  const added = DRY_RUN ? [] : queue.slice(0, allowance);
  for (const r of added) r.published_at = nowIso;
  const all = [...published, ...added].sort(byDateDesc);

  const catMap = new Map();
  for (const r of all) {
    const name = r.categorie_produit;
    const slug = slugify(name);
    if (!catMap.has(slug)) catMap.set(slug, { name, slug, count: 0, items: [] });
    const c = catMap.get(slug);
    c.count += 1;
    c.items.push(r);
  }
  const cats = [...catMap.values()].sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  const recordsChanged = JSON.stringify(all) !== JSON.stringify(oldMeta?.records || []);
  const generatedAt = recordsChanged || !oldMeta?.generated_at ? nowIso : oldMeta.generated_at;
  const apiTotal = recordsChanged ? total : oldMeta?.api_total_count ?? total;

  const summary = {
    ok: true,
    dry_run: DRY_RUN,
    today_utc: todayUtc,
    api_total: total,
    fetched: results.length,
    published_total: all.length,
    published_today_before_run: publishedToday.map((r) => r.id),
    added: added.map((r) => ({ id: r.id, libelle: r.libelle, severe: isSevere(r), lien: r.lien_officiel })),
    blocked_by_daily_guard: queue.length > 0 && allowance === 0,
    queue_count: queue.length - added.length,
    queue_next: queue.slice(added.length, added.length + 5).map((r) => ({ id: r.id, libelle: r.libelle, severe: isSevere(r) })),
    incomplete_skipped: incomplete,
    amazon_tag: affiliateCfg?.amazon?.amazon_tag || null,
    categories: cats.map((c) => `${c.slug}:${c.count}`),
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const payload = {
    generated_at: generatedAt,
    source: {
      dataset: "rappelconso-v2-gtin-espaces",
      api: API,
      license: "Licence Ouverte 2.0",
      portal: "https://rappel.conso.gouv.fr/",
    },
    publication_policy: `file d'attente : au plus ${MAX_NEW} nouvelle(s) fiche(s) par jour UTC (published_at)`,
    api_total_count: apiTotal,
    count: all.length,
    categories: cats.map(({ name, slug, count }) => ({ name, slug, count })),
    records: all,
  };
  writeFileSync(join(ROOT, "data/rappels.json"), JSON.stringify(payload, null, 2));

  writeCss();
  writeSearchJs();
  writeFileSync(join(ROOT, "index.html"), indexHtml(all, cats, affiliateCfg));
  writeFileSync(join(ROOT, "a-propos.html"), aboutHtml({
    generated_at: generatedAt,
    fiche_count: all.length,
    api_total_count: apiTotal,
  }, affiliateCfg));
  writeFileSync(join(ROOT, "categories/index.html"), categoryIndexHtml(cats, affiliateCfg));
  for (const cat of cats) {
    writeFileSync(join(ROOT, `categories/${cat.slug}.html`), categoryPageHtml(cat, cat.items, affiliateCfg));
  }
  let amazonCtas = 0;
  for (const r of all) {
    if (shouldShowAmazonCta(r, affiliateCfg)) amazonCtas += 1;
    writeFileSync(join(ROOT, `fiches/${r.id}.html`), ficheHtml(r, affiliateCfg));
  }

  const day = (iso) => String(iso || generatedAt).slice(0, 10);
  const sitemapUrls = [
    ["index.html", generatedAt],
    ["a-propos.html", generatedAt],
    ["categories/index.html", generatedAt],
    ...cats.map((c) => [`categories/${c.slug}.html`, generatedAt]),
    ...all.map((r) => [`fiches/${r.id}.html`, r.published_at || r.verified_at]),
  ];
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls
  .map(
    ([u, d]) => `  <url><loc>https://caro123-create.github.io/rappel-alertes/${u}</loc><lastmod>${day(d)}</lastmod></url>`
  )
  .join("\n")}
</urlset>
`;
  writeFileSync(join(ROOT, "sitemap.xml"), sitemap);
  writeFileSync(
    join(ROOT, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: https://caro123-create.github.io/rappel-alertes/sitemap.xml\n`
  );

  summary.amazon_ctas = amazonCtas;
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### Rappel Alertes — ${todayUtc}`,
      `- Fiches publiées au total : ${all.length}`,
      `- Ajoutée(s) : ${added.length ? added.map((r) => `${r.id} ${r.libelle}`).join(", ") : "aucune"}`,
      `- Garde-fou du jour actif : ${summary.blocked_by_daily_guard ? "oui" : "non"}`,
      `- En file d'attente : ${summary.queue_count}`,
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
