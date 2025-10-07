# France TopoJSON

Génère des fichiers TopoJSON optimisés pour les limites administratives françaises (régions, départements, EPCI, communes).

Source des données : [IGN Admin Express](https://geoservices.ign.fr/adminexpress)

## Installation

```bash
npm install
# ou
pnpm install
```

Prérequis : Node.js >= 18.0.0

## Utilisation

```bash
# Pipeline complet
npm run build              # Télécharge et convertit tout

# Par couche
npm run build:regions      # Régions uniquement
npm run build:departements # Départements uniquement
npm run build:epci         # EPCI uniquement
npm run build:communes     # Communes (fichier volumineux)

# Commandes individuelles
npm run download           # Télécharge les archives IGN
npm run convert            # Convertit Shapefile → GeoJSON + TopoJSON
npm run clean              # Supprime les fichiers générés
```

## Configuration

Le fichier `config.json` définit les couches à traiter :

```json
{
  "layers": [
    {
      "name": "regions",
      "enabled": true,
      "source": {
        "urls": ["https://data.geopf.fr/..."],
        "shapefile": "REGION.shp"
      },
      "precision": 0.00001,              // 5 décimales ≈ 1m
      "properties": ["NOM", "INSEE_REG"],
      "simplifications": [
        {
          "level": 2,                    // 2% de simplification
          "suffix": "-light",
          "precision": 0.0001,           // 4 décimales ≈ 11m
          "properties": ["INSEE_REG"]
        }
      ]
    }
  ]
}
```

**Paramètres clés :**
- `level` : Pourcentage de points conservés (2% = très simplifié, 100% = complet)
- `precision` : Décimales des coordonnées (0.00001 = 1m, 0.0001 = 11m)
- `properties` : Attributs à conserver dans le fichier final

## Structure

```
france-topojson/
├── scripts/
│   ├── download.js        # Téléchargement archives IGN
│   └── convert.js         # Conversion Shapefile → GeoJSON + TopoJSON
├── data/
│   ├── sources/           # Shapefiles téléchargés (généré)
│   ├── geojson/           # Fichiers GeoJSON (généré)
│   └── topojson/          # Fichiers TopoJSON (généré)
└── config.json            # Configuration
```

## Formats générés

Le script génère automatiquement **deux formats** :

**GeoJSON** (`data/geojson/`)
- Format standard, compatible avec tous les outils
- Utilisez pour Mapbox GL JS, Leaflet, ou si TopoJSON n'est pas supporté

**TopoJSON** (`data/topojson/`)
- Encode la topologie : frontières partagées stockées une fois
- 50-80% plus léger que GeoJSON
- Pas de gaps entre polygones adjacents
- Idéal pour cartes choroplèthes, D3.js

## Ressources

- [Mapshaper](https://mapshaper.org/) - Outil de conversion et simplification
- [TopoJSON Specification](https://github.com/topojson/topojson-specification)
- [D3.js](https://d3js.org/) - Visualisation avec support TopoJSON natif

## Licence

- **Code** : MIT
- **Données** : IGN sous [Licence Ouverte Etalab v2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/)
