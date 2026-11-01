
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://pokeapi.co/api/v2";

const DATA_DIR = path.join(__dirname, "data");
const NAMES_FILE = path.join(DATA_DIR, "pokemon-names.json");
const CACHE_FILE = path.join(DATA_DIR, "pokemon-cache.json");

app.use(express.static("public"));

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========================================
// JSON読み込み・保存
// ========================================

function loadJson(file, defaultValue) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch (error) {
    console.error(`JSON読み込みエラー: ${file}`, error);
  }

  return defaultValue;
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

let pokemonNames = loadJson(NAMES_FILE, []);
let pokemonCache = loadJson(CACHE_FILE, {});

// ========================================
// PokéAPIからポケモン一覧を取得
// ========================================

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`PokéAPI Error: ${response.status}`);
  }

  return response.json();
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (index < items.length) {
          const current = index++;
          await worker(items[current]);
        }
      }
    )
  );
}

async function loadPokemonNames() {
  if (pokemonNames.length > 0) {
    console.log(`キャッシュからポケモン一覧を読み込みました: ${pokemonNames.length}件`);
    return;
  }

  console.log("PokéAPIからポケモン一覧を取得しています...");

  const data = await fetchJson(
    `${API_BASE}/pokemon-species?limit=2000`
  );

  const names = [];

  await runWithConcurrency(data.results, 12, async (species) => {
    try {
      const speciesData = await fetchJson(species.url);

      const japaneseName = speciesData.names.find(
        (item) => item.language.name === "ja"
      );

      if (!japaneseName) return;

      names.push({
        id: speciesData.id,
        name: japaneseName.name,
        apiName: speciesData.name,
      });
    } catch (error) {
      console.error(`${species.name} の取得に失敗しました`);
    }
  });

  pokemonNames = names.sort((a, b) => a.id - b.id);

  saveJson(NAMES_FILE, pokemonNames);

  console.log(`ポケモン一覧を保存しました: ${pokemonNames.length}件`);
}

// ========================================
// 進化分類データの取得
//
// pre   : 進化前
// final : 最終進化
// none  : 進化しない
//
// 進化しないポケモンは「最終進化」にも含める。
// ========================================

async function ensureEvolutionMetadata() {
  if (
    pokemonNames.length > 0 &&
    pokemonNames.every((p) =>
      ["pre", "final", "none"].includes(p.evolutionType)
    )
  ) {
    return;
  }

  console.log("進化分類データを取得しています...");

  const chainUrls = new Set();

  await runWithConcurrency(pokemonNames, 12, async (pokemon) => {
    if (["pre", "final", "none"].includes(pokemon.evolutionType)) {
      return;
    }

    try {
      const species = await fetchJson(
        `${API_BASE}/pokemon-species/${encodeURIComponent(pokemon.apiName)}`
      );

      pokemon.evolvesFrom =
        species.evolves_from_species?.name || null;

      pokemon.evolutionChainUrl =
        species.evolution_chain?.url || null;

      if (pokemon.evolutionChainUrl) {
        chainUrls.add(pokemon.evolutionChainUrl);
      }
    } catch (error) {
      console.error(`${pokemon.name} の進化情報取得に失敗しました`);
    }
  });

  const finalSpecies = new Set();
  const nonEvolvingSpecies = new Set();

  await runWithConcurrency([...chainUrls], 8, async (chainUrl) => {
    try {
      const chainData = await fetchJson(chainUrl);

      function walk(node) {
        const children = node.evolves_to || [];

        if (children.length === 0) {
          finalSpecies.add(node.species.name);

          if (node === chainData.chain) {
            nonEvolvingSpecies.add(node.species.name);
          }

          return;
        }

        children.forEach(walk);
      }

      walk(chainData.chain);
    } catch (error) {
      console.error(`進化チェーン取得に失敗しました: ${chainUrl}`);
    }
  });

  for (const pokemon of pokemonNames) {
    if (nonEvolvingSpecies.has(pokemon.apiName)) {
      pokemon.evolutionType = "none";
    } else if (finalSpecies.has(pokemon.apiName)) {
      pokemon.evolutionType = "final";
    } else {
      pokemon.evolutionType = "pre";
    }
  }

  saveJson(NAMES_FILE, pokemonNames);

  console.log("進化分類データを保存しました。");
}

// ========================================
// ポケモン名検索
// ========================================

function searchPokemonName(keyword) {
  const search = keyword.trim().toLowerCase();

  if (!search) return [];

  return pokemonNames
    .filter((pokemon) =>
      pokemon.name.toLowerCase().includes(search) ||
      pokemon.apiName.toLowerCase().includes(search)
    )
    .slice(0, 20);
}

// ========================================
// ポケモン詳細取得
// ========================================

async function getPokemon(apiName) {
  if (pokemonCache[apiName]) {
    console.log(`${apiName}: キャッシュを使用`);
    return pokemonCache[apiName];
  }

  console.log(`${apiName}: PokéAPIから取得中...`);

  const data = await fetchJson(
    `${API_BASE}/pokemon/${encodeURIComponent(apiName)}`
  );

  const stats = {};

  for (const stat of data.stats) {
    stats[stat.stat.name] = stat.base_stat;
  }

  const result = {
    id: data.id,
    apiName: data.name,
    image: data.sprites?.front_default || null,
    hp: stats.hp || 0,
    attack: stats.attack || 0,
    defense: stats.defense || 0,
    specialAttack: stats["special-attack"] || 0,
    specialDefense: stats["special-defense"] || 0,
    speed: stats.speed || 0,
  };

  result.total =
    result.hp +
    result.attack +
    result.defense +
    result.specialAttack +
    result.specialDefense +
    result.speed;

  pokemonCache[apiName] = result;
  saveJson(CACHE_FILE, pokemonCache);

  return result;
}

// ========================================
// ランダムポケモン生成API
//
// /api/random?count=5
// /api/random?count=5&evolution=final
// /api/random?count=5&evolution=none
// ========================================

app.get("/api/random", async (req, res) => {
  try {
    let count = Number(req.query.count) || 1;
    count = Math.max(1, Math.min(count, 20));

    if (pokemonNames.length === 0) {
      return res.status(500).json({
        error: "ポケモンデータが読み込まれていません",
      });
    }

    const evolution = req.query.evolution || "all";

    if (!["all", "final", "none"].includes(evolution)) {
      return res.status(400).json({
        error: "進化条件の指定が正しくありません",
      });
    }

    if (evolution !== "all") {
      await ensureEvolutionMetadata();
    }

    let pool = [...pokemonNames];

    if (evolution === "final") {
      // 最終進化 + 進化しないポケモン
      pool = pool.filter(
        (p) =>
          p.evolutionType === "final" ||
          p.evolutionType === "none"
      );
    } else if (evolution === "none") {
      // 進化しないポケモンのみ
      pool = pool.filter(
        (p) => p.evolutionType === "none"
      );
    }

    if (pool.length === 0) {
      return res.status(404).json({
        error: "条件に合うポケモンが見つかりませんでした",
      });
    }

    // 重複しないようにランダム抽選
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const selected = pool.slice(0, Math.min(count, pool.length));

    res.json(selected);
  } catch (error) {
    console.error("ランダム取得エラー:", error);

    res.status(500).json({
      error: "ランダム取得に失敗しました",
    });
  }
});

// ========================================
// ポケモン検索API
// ========================================

app.get("/api/search", (req, res) => {
  try {
    const keyword = req.query.name?.trim();

    if (!keyword) {
      return res.status(400).json({
        error: "ポケモン名を入力してください",
      });
    }

    res.json(searchPokemonName(keyword));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "検索中にエラーが発生しました",
    });
  }
});

// ========================================
// ポケモン詳細API
// ========================================

app.get("/api/pokemon", async (req, res) => {
  try {
    const apiName = req.query.name?.trim();

    if (!apiName) {
      return res.status(400).json({
        error: "ポケモン名を指定してください",
      });
    }

    const pokemon = await getPokemon(apiName);

    const nameData = pokemonNames.find(
      (item) => item.apiName === apiName
    );

    res.json({
      ...pokemon,
      name: nameData?.name || apiName,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "データ取得に失敗しました",
    });
  }
});

// ========================================
// サーバー起動
// ========================================

async function startServer() {
  try {
    console.log("================================");
    console.log("ポケモン種族値検索アプリ");
    console.log("================================");

    await loadPokemonNames();

    app.listen(PORT, () => {
      console.log(`http://localhost:${PORT}`);
      console.log("でアプリが起動しました。");
    });
  } catch (error) {
    console.error("サーバー起動エラー");
    console.error(error);
  }
}

startServer();
