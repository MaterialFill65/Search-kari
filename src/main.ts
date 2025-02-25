import kuromoji from "vite-kuromoji.ts"
import fetchIndex from "./fetchIndex";

(async () => {
  // スコア重み設定
  const WEIGHTS = {
    TITLE_MATCH: 10,
    SPECIAL_WORD: 5,
    NORMAL_WORD: 1,
    PROXIMITY_BONUS: 0.5
  };

  // 特殊フィルター単語の定義
  const FILTERS = {
    "DICE_NOTATION": /dice/i,
    "SS_NOTATION": /SS/
  };


  let tokenizer: Awaited<ReturnType<typeof kuromoji.build>>;

  // インデックスの初期化
  let file: {
    titles: { [key: string]: string };
    author: { [key: string]: number[] };
    words_index: { [key: string]: Array<{ t: number; c: number }> };
    title_index: { [key: string]: Array<{ t: number; c: number }> };
  };

  // JSONファイルの読み込み
  async function initializeData() {
    const progressBar = document.getElementById('progress') as HTMLDivElement;
    const progressText = document.createElement('div');
    progressText.textContent = '辞書データ読み込み中...';
    progressBar.parentElement?.appendChild(progressText);
    tokenizer = await kuromoji.build({
      dicPath: "./aimasu",
      dicType: "UniDic"
    });
    progressText.textContent = '辞書データ読み込み完了...';
    progressText.style.position = 'absolute';
    progressText.style.width = '100%';
    progressText.style.textAlign = 'center';
    progressText.style.color = '#fff';

    if (progressBar) {
      progressBar.style.display = 'block';
      progressBar.style.width = '0%';
    }

    try {
      file = await fetchIndex((progress, message) => {
        if (progressBar) {
          progressBar.style.width = `${progress * 100}%`;
          progressText.textContent = message;
        }
      });
    } catch (error) {
      console.error('Failed to load index:', error);
      if (progressBar) {
        progressBar.style.backgroundColor = '#ff4646';
        progressText.textContent = 'エラーが発生しました';
      }
    } finally {
      progressText.remove();
    }
  }

  function calculateScore(
    threadId: number,
    queryTokens: ReturnType<typeof tokenizer.tokenizeSync>,
    matchedCounts: Map<string, number>
  ): number {
    let score = 0;

    // 基本スコアの計算
    for (const token of queryTokens) {
      if (!token.word_id) continue;

      // タイトルマッチのボーナス
      if (file.title_index[token.word_id]?.map(e => e.t).includes(threadId)) {
        score += WEIGHTS.TITLE_MATCH;
      } else {
        const counts = matchedCounts.get(token.surface_form)
        if (counts)
          score += WEIGHTS.NORMAL_WORD * counts;
      }
    }
    return score;
  }

  function mergeResults(results: Map<number, Map<string, number>>[]): Map<number, Map<string, number>> {
    const merged = new Map<number, Map<string, number>>();

    // 最初の結果セットのスレッドを基準にする
    const firstResult = results[0];
    if (!firstResult) return merged;

    // 全ての結果セットに存在するスレッドのみを残す（AND検索）
    for (const [threadId, _] of firstResult) {
      let existsInAll = true;

      // 他の全ての結果セットにもこのスレッドが存在するか確認
      for (let i = 1; i < results.length; i++) {
        if (!results[i].has(threadId)) {
          existsInAll = false;
          break;
        }
      }

      if (existsInAll) {
        merged.set(threadId, new Map());
        // 全ての結果セットからマッチ情報をマージ
        for (const result of results) {
          const matches = result.get(threadId);
          if (matches) {
            for (const [word, count] of matches) {
              if (!merged.get(threadId)?.has(word)) {
                merged.get(threadId)?.set(word, count);
              }
            }
          }
        }
      }
    }

    return merged;
  }

  function parseQuery(query: string): {
    author?: string;
    keywords: string[];
    negativeKeywords: string[];
    filters: Set<string>;
  } {
    const authorMatch = query.match(/author:(\S+)/);
    const author = authorMatch?.[1];

    const remainingQuery = query.replace(/author:\S+/, '').trim();
    const rawKeywords = remainingQuery.split(/\s+/).filter(k => k.length > 0);

    // キーワードを通常とマイナスに分類
    const keywords: string[] = [];
    const negativeKeywords: string[] = [];
    rawKeywords.forEach(k => {
      if (k.startsWith('-')) {
        negativeKeywords.push(k.slice(1));
      } else {
        keywords.push(k);
      }
    });
    console.log("neg:", negativeKeywords)
    console.log("pos:", keywords)

    // フィルター単語を検出
    const filters = new Set<string>();
    for (const [filterId, pattern] of Object.entries(FILTERS)) {
      if ([...keywords].some(k => pattern.test(k))) {
        filters.add(filterId);
      }
    }

    // フィルター単語を検索キーワードから除外
    const filterPattern = Object.values(FILTERS).map(p => p.source).join('|');
    const filterRegex = new RegExp(filterPattern, 'i');

    const normalKeywords = keywords.filter(k => !filterRegex.test(k));
    // const normalNegativeKeywords = negativeKeywords.filter(k => !filterRegex.test(k));

    return { author, keywords: normalKeywords, negativeKeywords: negativeKeywords, filters };
  }

  async function performSearch(query: string) {
    if (!query) return [];

    // クエリを解析
    const { author, keywords, negativeKeywords, filters } = parseQuery(query);

    // 作者で絞り込むスレッドIDのセット
    const targetThreads = author
      ? new Set(file.author[author] || [])
      : null;

    // フィルター条件のチェック
    const filterTargetThreads = filters.size > 0
      ? new Set(Array.from(filters).flatMap(filterId =>
        file.words_index[filterId]?.map(occ => occ.t) || []
      ))
      : null;

    if (author && targetThreads?.size === 0) {
      console.log("No threads found for this author.");
      return [];
    }

    // マイナス検索のための除外スレッドを収集
    const excludedThreads = new Set<number>();
    for (const negKeyword of negativeKeywords) {

      const negTokens = tokenizer.tokenizeSync(negKeyword);
      for (const token of negTokens) {
        if (token.word_id) {
          const occurrences = file.words_index[token.word_id] || [];
          occurrences.forEach(occ => excludedThreads.add(occ.t));
        }
      }
    }

    // キーワードがない場合は全スレッドを対象とする
    if (keywords.length === 0) {
      const allThreads = Object.keys(file.titles).map(Number);
      const results = allThreads
        .filter(threadId => {
          // 作者とフィルターの条件をチェック
          if (targetThreads && !targetThreads.has(threadId)) return false;
          if (filterTargetThreads && !filterTargetThreads.has(threadId)) return false;
          if (excludedThreads.has(threadId)) return false;  // 除外スレッドをチェック
          return true;
        })
        .map(threadId => ({
          threadId,
          score: 1, // 基本スコア
          matches: new Map<string, number>()
        }));
      return results;
    }

    // キーワード検索の処理
    const allResults: Map<number, Map<string, number>>[] = [];

    for (const keyword of keywords) {
      const tokens = tokenizer.tokenizeSync(keyword);
      const indice = tokens.map(token => {
        if (token.word_id) {
          return file.words_index[token.word_id] || [];
        }
        return [];
      });

      const matchInfo = new Map<number, Map<string, number>>();
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.word_id) continue;

        const occurrences = indice[i];
        for (const occ of occurrences) {
          // 作者とフィルター条件での絞り込み
          if (targetThreads && !targetThreads.has(occ.t)) continue;
          if (filterTargetThreads && !filterTargetThreads.has(occ.t)) continue;

          if (!matchInfo.has(occ.t)) {
            matchInfo.set(occ.t, new Map());
          }
          matchInfo.get(occ.t)?.set(token.surface_form, occ.c);
        }
      }

      allResults.push(matchInfo);
    }

    // 結果をマージする前に除外スレッドを適用
    const mergedResults = mergeResults(allResults);
    for (const threadId of excludedThreads) {
      mergedResults.delete(threadId);
    }

    // スコア計算と結果のソート
    const results = Array.from(mergedResults.entries())
      .map(([threadId, matches]) => ({
        threadId,
        score: calculateScore(threadId, tokenizer.tokenizeSync(query), matches),
        matches
      }))
      .sort((a, b) => b.score - a.score);

    return results;
  }

  // UI関連の処理
  await initializeData();

  const searchInput = document.getElementById('searchInput') as HTMLInputElement;
  const searchButton = document.getElementById('searchButton') as HTMLButtonElement;
  const resultsContainer = document.getElementById('resultsContainer');

  let isSearching = false;

  async function handleSearch() {
    if (isSearching) return;

    isSearching = true;
    searchButton.disabled = true;
    searchInput.disabled = true;
    searchButton.textContent = '検索中...';

    console.log("Search Start")
    const query = searchInput.value;

    try {
      const results = await performSearch(query);

      if (resultsContainer) {
        resultsContainer.innerHTML = results.map(({ threadId, score, matches }) => `
              <div class="result-item">
                  <a href="https://bbs.animanch.com/board/${threadId}/" 
                      class="result-link" 
                      target="_blank">
                    <h3 class="result-title">${file.titles[threadId]}</h3>
                  </a>
                  <div class="result-score">Score: ${score}</div>
                  <div class="result-matches">
                      マッチした単語: ${Array.from(matches.entries())
            .map(([word, count]) => `"${word}": ${count}`)
            .join('件, ') || "0"}件
                  </div>
              </div>
          `).join('');
        resultsContainer.innerHTML = `<h2>"${query}" の検索結果: ${results.length}件</h2>` + resultsContainer.innerHTML
      }
    } finally {
      isSearching = false;
      searchButton.disabled = false;
      searchInput.disabled = false;
      searchButton.textContent = '検索';
    }
  }

  searchButton?.addEventListener('click', handleSearch);
  searchInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
  });
})();