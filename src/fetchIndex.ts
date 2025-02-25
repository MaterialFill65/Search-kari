interface WordOccurrence {
    t: number;
    c: number;
}

interface WordIndex {
    [word_id: string]: WordOccurrence[];
}

interface IndexData {
    author: { [key: string]: number[] };
    words_index: WordIndex;
    title_index: WordIndex;
    titles: { [key: number]: string };
}

// プログレス報告用の型定義を追加
export interface ProgressCallback {
    (progress: number, message: string): void;
}

async function loadWordsIndex(onProgress: ProgressCallback): Promise<WordIndex> {
    // グループ一覧を読み込み
    const groupsResponse = await fetch('./words_index_groups.json');
    const groups: string[] = await groupsResponse.json();

    onProgress(0.1, 'グループ一覧を読み込みました');

    // 各グループのデータを読み込んで結合
    const words_index: WordIndex = {};
    let completed = 0;

    await Promise.all(groups.map(async (group) => {
        const response = await fetch(`./words_index_${group}.json`);
        const groupData: WordIndex = await response.json();
        Object.assign(words_index, groupData);
        
        completed++;
        const progress = 0.1 + (completed / groups.length * 0.6); // 10%~70%
        onProgress(progress, `単語インデックス ${completed}/${groups.length} を読み込み中...`);
    }));

    return words_index;
}

export default async function fetchIndex(onProgress: ProgressCallback = () => {}) {
    try {
        onProgress(0, 'インデックスの読み込みを開始');

        // 並行して各ファイルをフェッチ
        const [authorResponse, titleIndexResponse, titlesResponse] = await Promise.all([
            fetch('./author.json'),
            fetch('./title_index.json'),
            fetch('./titles.json')
        ]);

        onProgress(0.8, '基本データを読み込み中...');

        // 各データをJSONとしてパース
        const [author, title_index, titles, words_index] = await Promise.all([
            authorResponse.json(),
            titleIndexResponse.json(),
            titlesResponse.json(),
            loadWordsIndex(onProgress)
        ]);

        onProgress(0.9, 'データを結合中...');

        // 元の形式に再構築
        const result: IndexData = {
            author,
            words_index,
            title_index,
            titles
        };

        onProgress(1.0, '読み込み完了!');

        console.log('Merge complete!');
        console.log(`Data size: ${(JSON.stringify(result).length / 1024 / 1024).toFixed(2)} MB`);

        return result;
    } catch (error) {
        if (error instanceof Error) {
            alert('なんかバグりました！\n' + error.message);
        }
        throw error;
    }
}
