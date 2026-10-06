const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;

const API_BASE = "https://pokeapi.co/api/v2";

const DATA_DIR = path.join(__dirname, "data");
const NAMES_FILE = path.join(DATA_DIR, "pokemon-names.json");
const CACHE_FILE = path.join(DATA_DIR, "pokemon-cache.json");

app.use(express.static("public"));


// ========================================
// データ保存用フォルダ
// ========================================

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}


// ========================================
// JSON読み込み・保存
// ========================================

function loadJson(file, defaultValue) {

  try {

    if (fs.existsSync(file)) {

      return JSON.parse(
        fs.readFileSync(file, "utf8")
      );

    }

  } catch (error) {

    console.error(
      `JSON読み込みエラー: ${file}`
    );

  }

  return defaultValue;
}


function saveJson(file, data) {

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );

}


// ========================================
// キャッシュ
// ========================================

let pokemonNames =
  loadJson(NAMES_FILE, []);

let pokemonCache =
  loadJson(CACHE_FILE, {});


// ========================================
// PokéAPIから全ポケモン一覧を取得
// ========================================

async function loadPokemonNames() {

  if (pokemonNames.length > 0) {

    console.log(
      `キャッシュからポケモン一覧を読み込みました`
    );

    console.log(
      `${pokemonNames.length}件`
    );

    return;

  }


  console.log(
    "PokéAPIからポケモン一覧を取得しています..."
  );


  const response = await fetch(
    `${API_BASE}/pokemon-species?limit=2000`
  );


  if (!response.ok) {

    throw new Error(
      `PokéAPI Error: ${response.status}`
    );

  }


  const data =
    await response.json();


  console.log(
    `${data.results.length}件のポケモンを取得しました`
  );


  console.log(
    "日本語名を取得しています..."
  );


  let count = 0;


  for (const species of data.results) {

    try {

      const speciesResponse =
        await fetch(species.url);


      if (!speciesResponse.ok) {
        continue;
      }


      const speciesData =
        await speciesResponse.json();


      const japaneseName =
        speciesData.names.find(
          item =>
            item.language.name === "ja"
        );


      if (!japaneseName) {
        continue;
      }


      pokemonNames.push({

        id:
          speciesData.id,

        name:
          japaneseName.name,

        apiName:
          speciesData.name

      });


      count++;


      if (count % 50 === 0) {

        console.log(
          `${count}件処理しました...`
        );

      }


    } catch (error) {

      console.error(
        `${species.name} の取得に失敗しました`
      );

    }

  }


  saveJson(
    NAMES_FILE,
    pokemonNames
  );


  console.log(
    `日本語名データを保存しました: ${pokemonNames.length}件`
  );

}


// ========================================
// ポケモン名検索
// ========================================

function searchPokemonName(keyword) {

  const search =
    keyword
      .trim()
      .toLowerCase();


  if (!search) {
    return [];
  }


  return pokemonNames
    .filter(pokemon => {

      return (

        pokemon.name
          .toLowerCase()
          .includes(search)

        ||

        pokemon.apiName
          .toLowerCase()
          .includes(search)

      );

    })

    .slice(0, 20);

}


// ========================================
// ポケモン詳細取得
// ========================================

async function getPokemon(apiName) {


  // キャッシュに存在
  if (pokemonCache[apiName]) {

    console.log(
      `${apiName}: キャッシュを使用`
    );

    return pokemonCache[apiName];

  }


  console.log(
    `${apiName}: PokéAPIから取得中...`
  );


  const response =
    await fetch(
      `${API_BASE}/pokemon/${encodeURIComponent(apiName)}`
    );


  if (!response.ok) {

    if (response.status === 404) {

      throw new Error(
        "ポケモンが見つかりませんでした"
      );

    }


    throw new Error(
      `PokéAPI Error: ${response.status}`
    );

  }


  const data =
    await response.json();


  // ========================================
  // 種族値
  // ========================================

  const stats = {};


  for (const stat of data.stats) {

    stats[
      stat.stat.name
    ] =
      stat.base_stat;

  }


  const result = {

    id:
      data.id,

    apiName:
      data.name,

    image:
      data.sprites?.front_default || null,

    hp:
      stats.hp || 0,

    attack:
      stats.attack || 0,

    defense:
      stats.defense || 0,

    specialAttack:
      stats["special-attack"] || 0,

    specialDefense:
      stats["special-defense"] || 0,

    speed:
      stats.speed || 0

  };


  // ========================================
  // 種族値合計
  // ========================================

  result.total =

    result.hp +

    result.attack +

    result.defense +

    result.specialAttack +

    result.specialDefense +

    result.speed;


  // キャッシュ
  pokemonCache[apiName] =
    result;


  saveJson(
    CACHE_FILE,
    pokemonCache
  );


  return result;

}

// ========================================
// ポケモンランダム生成API
// ========================================

app.get(
  "/api/random",
  async (req, res) => {

    try {

      let count =
        Number(req.query.count) || 1;

      // 1〜20に制限
      count =
        Math.max(
          1,
          Math.min(
            count,
            20
          )
        );


      if (pokemonNames.length === 0) {

        return res.status(500).json({

          error:
            "ポケモンデータが読み込まれていません"

        });

      }


      // 重複しないようにランダム抽出

      const shuffled =
        [...pokemonNames]
          .sort(
            () => Math.random() - 0.5
          );


      const selected =
        shuffled.slice(
          0,
          count
        );


      res.json(
        selected
      );


    } catch (error) {

      console.error(error);


      res.status(500).json({

        error:
          "ランダム取得に失敗しました"

      });

    }

  }
);

// ========================================
// ポケモン検索API
// ========================================

app.get(
  "/api/search",
  async (req, res) => {

    try {

      const keyword =
        req.query.name?.trim();


      if (!keyword) {

        return res.status(400).json({

          error:
            "ポケモン名を入力してください"

        });

      }


      const results =
        searchPokemonName(keyword);


      res.json(results);


    } catch (error) {

      console.error(error);


      res.status(500).json({

        error:
          "検索中にエラーが発生しました"

      });

    }

  }
);


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

          error:
            "ポケモン名を指定してください"

        });

      }


      const pokemon =
        await getPokemon(apiName);


      const nameData =
        pokemonNames.find(
          item =>
            item.apiName === apiName
        );


      res.json({

        ...pokemon,

        name:
          nameData?.name || apiName

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

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "ポケモン種族値検索アプリ"
    );

    console.log(
      "================================"
    );


    await loadPokemonNames();


    app.listen(
      PORT,
      () => {

        console.log("");

        console.log(
          `http://localhost:${PORT}`
        );

        console.log(
          "でアプリが起動しました。"
        );

        console.log("");

        console.log(
          "例：ピカチュウ / ミュウツー / リザードン"
        );

      }
    );


  } catch (error) {

    console.error("");

    console.error(
      "サーバー起動エラー"
    );

    console.error(error);

  }

}


startServer();