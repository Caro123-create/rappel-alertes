# Rappel Alertes

Site statique francophone d’**alertes de rappels produits**, alimenté par l’open data officiel **RappelConso** (data.economie.gouv.fr).

Projet de Carole, géré par l’agent **Mogul**. Indépendant de l’activité d’autrice Elena Reign.

## Contenu

| Chemin | Rôle |
|--------|------|
| `index.html` | Accueil, recherche marque/produit, derniers rappels |
| `categories/` | Pages par `categorie_produit` |
| `fiches/<id>.html` | Fiche détail + lien officiel + dates |
| `a-propos.html` | Sources, Licence Ouverte, méthode |
| `data/rappels.json` | Données structurées (avec `source_url` et `verified_at`) |
| `scripts/fetch-rappels.mjs` | Collecte API + régénération du site |
| `assets/` | CSS / JS (recherche côté client) |

## Source des données

- Jeu : [`rappelconso-v2-gtin-espaces`](https://data.economie.gouv.fr/explore/dataset/rappelconso-v2-gtin-espaces/)
- API Explore v2.1 : `…/catalog/datasets/rappelconso-v2-gtin-espaces/records`
- Portail public : [rappel.conso.gouv.fr](https://rappel.conso.gouv.fr/)
- Licence : **Licence Ouverte 2.0** (Etalab) — réutilisation autorisée avec attribution

Aucune donnée n’est inventée : seuls les champs de l’API sont repris. Chaque fiche affiche le lien officiel RappelConso, la date de publication API et la date de vérification Mogul.

## Régénérer localement

```bash
node scripts/fetch-rappels.mjs
```

Puis prévisualiser :

```bash
python3 -m http.server 8765 --directory /workspace/rappel-alertes
```

Ouvrir : `http://127.0.0.1:8765/` (sur la machine box / bureau Mogul).

## Déploiement GitHub Pages (prochaine étape)

1. Créer un dépôt GitHub (ex. `rappel-alertes`) une fois `gh` authentifié.
2. `git remote add origin …` puis `git push -u origin main`.
3. Settings → Pages → Source : branche `main`, dossier `/` (ou `/docs` si on déplace).
4. Mettre à jour `sitemap.xml` / `robots.txt` en remplaçant `EXAMPLE.github.io` par l’URL réelle.
5. Optionnel : GitHub Action quotidienne à 3 h Europe/Madrid pour relancer `fetch-rappels.mjs` et committer.

**Aucun push n’a été effectué** tant que GitHub n’est pas connecté.

## Analytics

Placeholder HTML commenté pour Plausible / Cloudflare Web Analytics — **non actif**.

## Statut MVP

- Site statique : préparé + testé (génération + serveur local)
- Pipeline données : testé (API 19 090+ enregistrements)
- GitHub Pages : proposé (auth manquante)
- Automatisation quotidienne / Telegram : non démarré dans ce lot
