
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://pokeapi.co/api/v2";

const DATA_DIR = path.join(__dirname, "data");
const NAMES_FILE = path.join(DATA_DIR, "pokemon-names.json");
const CACHE_FILE = path.join(DATA_DIR, "pokemon-cache.json");

const LANGUAGE_CODES = [
  "ja",
  "en",
  "fr",
  "de",
  "es",
  "it",
  "ko",
  "zh-Hans",
  "zh-Hant",
  "pt"
];

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

// メガシンカ情報のキャッシュ
let megaFormsCache = null;

// PokéAPIからメガシンカ情報を取得
async function getMegaForms() {
  if (megaFormsCache) return megaFormsCache;

  try {
    // フォーム一覧を取得
    const response = await fetch(
      "https://pokeapi.co/api/v2/pokemon-form/?limit=2000"
    );

    if (!response.ok) {
      throw new Error("フォーム一覧の取得に失敗しました");
    }

    const list = await response.json();

    // 名前にmegaが含まれるフォームだけ取得
    const megaCandidates = list.results.filter(item =>
      item.name.includes("mega")
    );

    // 各フォームの詳細を取得
    const details = await Promise.all(
      megaCandidates.map(async item => {
        try {
          const res = await fetch(item.url);
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      })
    );

    const megaForms = {};

    for (const form of details) {
      if (!form || !form.is_mega) continue;

      const megaApiName = form.pokemon.name;

      // メガフォーム名から元のポケモン名を取得
      const baseApiName = megaApiName.replace(
        /-mega(?:-[xy])?$/,
        ""
      );

      if (baseApiName === megaApiName) continue;

      // 日本語名を取得。なければ元の名前から作成
      const japaneseName = form.names?.find(
        item => item.language.name === "ja"
      )?.name;

      const baseName = pokemonNames.find(
        item => item.apiName === baseApiName
      )?.name;

      let displayName = japaneseName;

      if (!displayName) {
        const suffix = megaApiName.endsWith("-mega-x")
          ? "X"
          : megaApiName.endsWith("-mega-y")
            ? "Y"
            : "";

        displayName = `メガ${baseName || baseApiName}${suffix}`;
      }

      if (!megaForms[baseApiName]) {
        megaForms[baseApiName] = [];
      }

      megaForms[baseApiName].push({
        apiName: megaApiName,
        name: displayName
      });
    }

    megaFormsCache = megaForms;

    console.log(
      "メガシンカ情報取得完了:",
      Object.keys(megaForms).length,
      "種類"
    );

    return megaForms;

  } catch (error) {
    console.error("メガシンカ情報取得エラー:", error);
    return {};
  }
}

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

    // メガシンカ情報を取得
    const megaForms = await getMegaForms();

    // ランダムに選んだポケモンをメガシンカさせる
    const selected = pool
      .slice(0, count)
      .map(pokemon => {
        const forms = megaForms[pokemon.apiName];

        // メガシンカできない場合は通常の姿
        if (!forms || forms.length === 0) {
          return pokemon;
        }

        // 複数のメガシンカがある場合はランダム選択
        const megaForm = forms[
          Math.floor(Math.random() * forms.length)
        ];

        return {
          ...pokemon,
          apiName: megaForm.apiName
        };
      });

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


app.get(
  "/api/pokemon",
  async (req, res) => {

    try {

      const apiName =
        req.query.name?.trim();

      if (!apiName) {
        return res.status(400).json({
          error: "ポケモン名を指定してください"
        });
      }

      // ポケモンの基本情報
      const pokemon =
        await getPokemon(apiName);

      // ポケモン一覧から日本語名を取得
      const nameData =
        pokemonNames.find(
          item => item.apiName === apiName
        );

      // 既存の多言語名キャッシュ
      let localizedNames = {
        ...(nameData?.names || {})
      };

      // 中国語のキーを統一
      if (localizedNames["zh-hans"]) {
        localizedNames["zh-Hans"] =
          localizedNames["zh-hans"];
      }

      if (localizedNames["zh-hant"]) {
        localizedNames["zh-Hant"] =
          localizedNames["zh-hant"];
      }

      // 取得が必要な言語があるか確認
      const needsFetch =
        LANGUAGE_CODES.some(
          language => !localizedNames[language]
        );

      if (needsFetch) {

        try {

          const speciesId =
            nameData?.id || pokemon.id;

          const speciesResponse =
            await fetch(
              `${API_BASE}/pokemon-species/${speciesId}`
            );

          if (speciesResponse.ok) {

            const speciesData =
              await speciesResponse.json();

            // 言語一覧を確認
            console.log(
              `${apiName} の言語一覧:`,
              (speciesData.names || []).map(entry => ({
                language: entry.language?.name,
                name: entry.name
              }))
            );

            // PokéAPIから取得した名前を反映
            for (const entry of speciesData.names || []) {

              const language =
                entry.language?.name?.toLowerCase();

              if (!language) continue;

              // 日本語
              if (
                language === "ja" ||
                language === "ja-hrkt"
              ) {
                localizedNames.ja =
                  entry.name;
              }

              // 英語
              else if (language === "en") {
                localizedNames.en =
                  entry.name;
              }

              // フランス語
              else if (language === "fr") {
                localizedNames.fr =
                  entry.name;
              }

              // ドイツ語
              else if (language === "de") {
                localizedNames.de =
                  entry.name;
              }

              // スペイン語
              else if (language === "es") {
                localizedNames.es =
                  entry.name;
              }

              // イタリア語
              else if (language === "it") {
                localizedNames.it =
                  entry.name;
              }

              // 韓国語
              else if (language === "ko") {
                localizedNames.ko =
                  entry.name;
              }

              // 中国語・簡体字
              else if (language === "zh-hans") {
                localizedNames["zh-Hans"] =
                  entry.name;
              }

              // 中国語・繁体字
              else if (language === "zh-hant") {
                localizedNames["zh-Hant"] =
                  entry.name;
              }

              // ポルトガル語
              else if (language === "pt") {
                localizedNames.pt =
                  entry.name;
              }

            }

            // 中国語が片方しかない場合は補完
            if (
              !localizedNames["zh-Hans"] &&
              localizedNames["zh-Hant"]
            ) {
              localizedNames["zh-Hans"] =
                localizedNames["zh-Hant"];
            }

            if (
              !localizedNames["zh-Hant"] &&
              localizedNames["zh-Hans"]
            ) {
              localizedNames["zh-Hant"] =
                localizedNames["zh-Hans"];
            }

            // 日本語名がなければ一覧データから補完
            if (
              !localizedNames.ja &&
              nameData?.name
            ) {
              localizedNames.ja =
                nameData.name;
            }

            // 多言語名をキャッシュ
            if (nameData) {

              nameData.names =
                localizedNames;

              saveJson(
                NAMES_FILE,
                pokemonNames
              );

            }

          } else {

            console.error(
              `${apiName} の種族情報取得に失敗:`,
              speciesResponse.status
            );

          }

        } catch (error) {

          console.error(
            `${apiName} の多言語名取得に失敗:`,
            error.message
          );

        }

      }

      // 日本語名の最終補完
      if (
        !localizedNames.ja &&
        nameData?.name
      ) {
        localizedNames.ja =
          nameData.name;
      }

      // フロントエンドへ返す
      res.json({

        ...pokemon,

        name:
          nameData?.name || apiName,

        names:
          localizedNames

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        error:
          error.message ||
          "データ取得に失敗しました"

      });

    }

  }
);


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
