import { BlueskyUtil } from './bluesky-util.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';

/**
 * 日本時間（JST）のDateオブジェクトを取得
 * @returns {Date} 日本時間のDateオブジェクト
 */
function getJSTDate() {
	const now = new Date();
	// UTC時刻に9時間を加算してJSTに変換
	return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

/**
 * 日本時間の時間帯を判定
 * @param {Date} jstDate 日本時間のDateオブジェクト
 * @returns {string} 時間帯（'朝', '昼', '夜'）
 */
function getTimeOfDay(jstDate) {
	const hour = jstDate.getHours();
	// 6～11時：朝
	if (hour >= 6 && hour < 11) {
		return '朝';
	}
	// 11～18時：昼
	if (hour >= 11 && hour < 18) {
		return '昼';
	}
	// 18～翌6時：夜
	return '夜';
}

/**
 * 日本時間を運動記録用の日付（YYYY-MM-DD）に変換
 * 深夜3時より前は前日扱いとする
 * @param {Date} jstDate 日本時間のDateオブジェクト
 * @returns {string} YYYY-MM-DD形式の日付文字列
 */
function getExerciseDate(jstDate) {
	const hour = jstDate.getHours();
	let targetDate = new Date(jstDate);
	
	// 深夜0時～3時の場合は前日扱い
	if (hour < 3) {
		targetDate.setDate(targetDate.getDate() - 1);
	}
	
	const year = targetDate.getFullYear();
	const month = String(targetDate.getMonth() + 1).padStart(2, '0');
	const day = String(targetDate.getDate()).padStart(2, '0');
	
	return `${year}-${month}-${day}`;
}

/**
 * 投稿日時から継続日数を計算
 * @param {string} currentPostCreatedAt 現在の投稿のcreatedAt（ISO 8601形式）
 * @param {string|null} lastTrainingDate 前回の運動記録日（YYYY-MM-DD形式）
 * @param {number} previousConsecutiveDays 前回の継続日数
 * @returns {number} 新しい継続日数
 */
function calculateConsecutiveDays(currentPostCreatedAt, lastTrainingDate, previousConsecutiveDays) {
	// 投稿日時をUTC → JSTに変換
	const postDate = new Date(currentPostCreatedAt);
	const jstPostDate = new Date(postDate.getTime() + 9 * 60 * 60 * 1000);
	
	// 運動記録用の日付を取得（深夜3時区切り）
	const currentExerciseDate = getExerciseDate(jstPostDate);
	
	// 初回の場合
	if (!lastTrainingDate) {
		return 1;
	}
	
	// 同じ日の場合は継続日数を維持
	if (currentExerciseDate === lastTrainingDate) {
		return previousConsecutiveDays;
	}
	
	// 前回の日付から日数差を計算
	const lastDate = new Date(lastTrainingDate + 'T00:00:00+09:00');
	const currentDate = new Date(currentExerciseDate + 'T00:00:00+09:00');
	const daysDiff = Math.floor((currentDate - lastDate) / (24 * 60 * 60 * 1000));
	
	// 1日後なら継続日数を増やす
	if (daysDiff === 1) {
		return previousConsecutiveDays + 1;
	}
	
	// 2日以上空いた場合はリセット
	return 1;
}

const RULES = `# Gemini 回答生成ルール

あなたはプロのフィットネストレーナーであり、Blueskyに投稿するボットです。
**最重要ルール：生成するテキストは、絶対に300文字以内に収めてください。**
これはBlueskyのシステム的な文字数制限であり、超えると投稿が途中で切り捨てられ、非常に不自然になります。このルールは他のどの指示よりも優先されます。

## 回答の構成

1.  **採点（xx点）：** 最初に100点満点で採点結果を提示します。
2.  **褒め言葉:** トレーニングの良い点を1つ、具体的に褒めます。
3.  **応援メッセージ:** 現在の日時に応じた短い励ましの言葉で締めくくります。平日と休日は区別してください。
4.  **履歴情報（区切り線以降）:** 回答の最後に「---」で区切り、次回評価用の履歴情報を記載してください。

## 採点基準

-   画像から読み取れるスコアよりも運動している時間と継続日数を重点的に評価します。
-   以下の基準で点数をつけ、内容に応じて調整してください。
    -   100点: 運動時間が30分以上、継続日数が3日以上
    -   90点: 運動時間が30分以上、継続日数が2日以上
    -   80点: 運動時間が30分以上、継続日数が1日以上
    -   70点: 運動時間が30分以上、継続日数が1日未満
-   1週間のうち1,2日程度の休みであれば休息日として評価、継続しているものとしてください。

## 履歴情報の記載方法

回答の最後に「---」で区切り、以下の情報を箇条書きで記載してください：
-   その他：**80-100文字程度**、投稿文や画像から読み取れる情報を網羅的に記載
    -   運動の種類と内容（例：ランニング5km、スクワット50回、HIIT20分）
    -   運動時間や時間帯（例：30分、朝7時、夜トレーニング）
    -   体調や疲労度（例：膝に軽い痛み、体調良好、前日の疲労残る）
    -   特記事項（例：雨天のため室内、新メニュー開始、休息後の再開）
    -   画像のスコアや数値（例：カロリー消費300kcal、心拍数150）

**重要：次回の評価に必要な情報を具体的に記載してください。簡潔すぎる記載は避けてください。**
**注意：継続日数や最後にトレーニングした日などの情報は、システムで自動管理されているため記載しないでください。**

例：
---
- その他：ランニング5km、30分実施。心拍数平均145。前日は足に軽い痛みがあったが今日は問題なし。ウェイトトレーニングとの交互実施を継続中。天候良好。

※この履歴情報は次回の評価時に参考情報として使用されます。ユーザーには表示されません。

## 履歴情報の活用方法

前回までの履歴情報が提供されている場合、以下のように活用してください：
-   継続日数を見て、トレーニングの継続性を評価・応援する
-   前回の体調不良や痛みが記録されている場合：今回の投稿で問題なくトレーニングできていれば、回復を喜ぶコメントを含める
    -   例：「足の痛みは大丈夫ですか？ 回復したのであればなによりです！」
-   前回のトレーニング内容を参考に、継続性や変化を評価する
-   前回の課題や目標が記録されている場合、その達成状況を確認してコメントする

## スタイル

-   常にポジティブで、モチベーションを高めるトーンを維持してください。
-   ハッシュタグ（#）は絶対に含めないでください。
-   専門用語を避け、誰にでも分かりやすい言葉で説明してください。
-   「現在の日時」は日本時間（JST）で24時間表記です。
-   「時間帯」は以下のように判定されます：
    -   朝：6時～11時
    -   昼：11時～18時
    -   夜：18時～翌6時
-   「時間帯」が朝の場合、その日の活力を引き出すような内容にしてください。
-   「時間帯」が昼の場合、午後の活力を引き出すような内容にしてください。
-   「時間帯」が夜の場合、一日の疲れを労うような内容にしてください。
-   「現在の日時」を内容に含める必要はありません。
-   文面から当日2回目以降のエクササイズだと読み取れる場合、評価を高めにしてください。
-   画像内のスコアは中途半端でも最高得点であることがあります。改善点には含めないようにしてください。
-   文面から体調不良などの理由が読み取れる場合、マイナス評価せず、再開したことを褒めてください。
-   休息日を設けず1週間以上継続している場合、休息日を提案してください。
-   過剰なトレーニングなど誤った箇所があれば指摘してください。
`;

const REMINDER_RULES = `# リマインダーメッセージ生成ルール

あなたはプロのフィットネストレーナーであり、しばらく運動していないユーザーに声をかけるボットです。
**最重要ルール：生成するテキストは、絶対に300文字以内に収めてください。**

## メッセージの方針

-   最近運動していない人に対する問いかけです
-   あくまで「サボってないか？」ではなく「体調は大丈夫か？」と心配するニュアンスで問いかけてください
-   体調不良以外にも旅行や疲れ、趣味に没頭しすぎたなどがありえます
-   無理をせず、自分のペースで大丈夫だということを伝えてください
-   前向きで優しいトーンを維持してください

## スタイル

-   ハッシュタグ（#）は絶対に含めないでください。
-   専門用語を避け、誰にでも分かりやすい言葉で説明してください。
-   「現在の日時」は日本時間（JST）で24時間表記です。
-   「時間帯」は以下のように判定されます：
    -   朝：6時～11時
    -   昼：11時～18時
    -   夜：18時～翌6時
-   「時間帯」に応じて適切なトーンでメッセージを作成してください。
-   「現在の日時」を内容に含める必要はありません。
`;

export default {
	async scheduled(event, env, ctx) {
		try {
			await handleScheduled(env);
		} catch (error) {
			console.error('Scheduled handler error:', error);
		}
	},

	async fetch(request, env, ctx) {
		return new Response('Exercise Trainer Bot is running!', { status: 200 });
	},
};

async function handleScheduled(env) {
	const bsky = new BlueskyUtil(env);
	await bsky.loadSession();

	// 現在時刻から24時間前まで検索範囲を拡大
	const now = new Date();
	const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	const until = now.toISOString();

	// 検索制限を削減してAPI呼び出しを軽量化
	const posts = await bsky.searchPosts({
		query: '#青空筋トレ部',
		limit: 20,
		author: env.CHECK_BSKY_DID,
		since,
		until,
	});

	if (!posts || !posts.data || !posts.data.posts || !Array.isArray(posts.data.posts)) {
		await checkAndSendReminder(env, bsky);
		return;
	}

	// 処理済みポストのURIを取得
	const processedPosts = await getProcessedPosts(env);

	let newPostsCount = 0;
	let latestPostTime = null;
	
	// ハッシュタグ付き投稿の処理
	
	for (const post of posts.data.posts) {
		// 既に処理済みのポストはスキップ
		if (processedPosts.has(post.uri)) {
			continue;
		}

		try {
			const postData = {
				text: post.record.text,
				created_at: post.record.createdAt,
				author: post.author.did,
				uri: post.uri,
			};

			// 画像URLを取得
			if (post.embed?.images) {
				postData.images = post.embed.images.map(img => img.fullsize);
			}

			let responseText;
			try {
				responseText = await analyzeWithGemini(postData, env);
			} catch (error) {
				// AIモデルが使用できない場合の専用メッセージ
				if (error.message === 'AI_MODEL_NOT_AVAILABLE') {
					const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';
					responseText = `申し訳ございません。現在使用しているAIモデル（${modelName}）が利用できなくなっています。\n\nボットの管理者に連絡し、AIモデルの設定を更新する必要があります。しばらくお待ちください。`;
					console.error('AI model not available:', modelName);
				} else {
					throw error;
				}
			}
			
			await bsky.postReply(responseText, post.uri, post.cid);
			
			// 処理完了後、KVに記録
			await markPostAsProcessed(post.uri, env);
			newPostsCount++;
			
			// 最新の投稿時刻を記録
			const postTime = new Date(postData.created_at);
			if (!latestPostTime || postTime > latestPostTime) {
				latestPostTime = postTime;
			}
		} catch (error) {
			console.error('Error processing post:', error.message);
		}
	}
	
	
	if (latestPostTime) {
		await updateLastEvaluationTime(latestPostTime.toISOString(), env);
	}
	
	// 10回に1回だけクリーンアップを実行してCPU時間削減
	const shouldCleanup = Math.random() < 0.1;
	if (shouldCleanup) {
		await cleanupOldProcessedPosts(env);
	}
	
	await handleNotifications(env, bsky);
	
	await checkAndSendReminder(env, bsky);
}

async function analyzeWithGemini(postData, env, isSimpleReply = false) {
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
	const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';
	
	let model;
	try {
		model = genAI.getGenerativeModel({ model: modelName });
	} catch (error) {
		console.error('Failed to get AI model:', error);
		throw new Error('AI_MODEL_NOT_AVAILABLE');
	}

	// 日本時間を取得して時間帯を判定
	const jstDate = getJSTDate();
	const timeOfDay = getTimeOfDay(jstDate);
	const formattedTime = jstDate.toLocaleString('ja-JP', { hour12: false });

	// 会話の続きの場合は簡単な返答用プロンプト
	let prompt;
	let shouldSaveHistory = false;
	
	if (isSimpleReply) {
		prompt = `あなたはフレンドリーなフィットネストレーナーです。ユーザーの返信に対して、30文字程度の自然で簡潔な返答をしてください。

# ユーザーのメッセージ:
${postData.text}

現在の日時: ${formattedTime}

※ルールに従った評価は不要です。会話を続けようとせず、感謝や応援の気持ちを伝える簡潔な返答をしてください。`;
	} else {
		// 通常の評価の場合は履歴情報を取得してプロンプトに含める
		shouldSaveHistory = true;
		const history = await getExerciseHistory(postData.author, env);
		
		// 投稿日時から継続日数を計算
		const consecutiveDays = calculateConsecutiveDays(
			postData.created_at,
			history.lastTrainingDate,
			history.consecutiveDays
		);
		
		// 計算した継続日数をpostDataに追加（後で保存するため）
		postData.calculatedConsecutiveDays = consecutiveDays;
		
		// 投稿日時から運動記録日を取得（UTC → JSTに変換）
		const postDate = new Date(postData.created_at);
		const jstPostDate = new Date(postDate.getTime() + 9 * 60 * 60 * 1000);
		postData.calculatedExerciseDate = getExerciseDate(jstPostDate);
		
		let historyContext = '';
		if (history.lastTrainingDate) {
			historyContext = '\n\n# 前回までの履歴情報:\n';
			historyContext += `- 最後にトレーニングした日：${history.lastTrainingDate}\n`;
			historyContext += `- 連続でトレーニングしている日数：${consecutiveDays}\n`;
			if (history.notes) {
				historyContext += `- その他：${history.notes}\n`;
			}
			historyContext += '\n※この履歴情報を考慮して評価してください。';
		} else {
			historyContext = '\n\n# 前回までの履歴情報:\n';
			historyContext += '- これが初回のトレーニング記録です\n';
			historyContext += `- 連続でトレーニングしている日数：1\n`;
		}
		
		prompt = `${RULES}\n\n# 投稿内容:\n${postData.text}\n\n現在の日時: ${formattedTime}\n時間帯: ${timeOfDay}${historyContext}\n\n`;
	}

	// 画像がある場合は画像も含めて送信
	const parts = [{ text: prompt }];
	
	if (postData.images && postData.images.length > 0) {
		try {
			// 画像処理を並列化してCPU時間削減
			const imagePromises = postData.images.slice(0, 4).map(async (imageUrl) => {
				try {
					const imageResponse = await fetch(imageUrl);
					return await imageResponse.arrayBuffer();
				} catch (error) {
					console.error('Error loading image:', error.message);
					return null;
				}
			});
			
			const imageBuffers = (await Promise.all(imagePromises)).filter(buf => buf !== null);
			
			if (imageBuffers.length > 0) {
				const gridBuffer = await createImageGrid(imageBuffers);
				const base64Image = arrayBufferToBase64(gridBuffer);
				
				parts.push({
					inlineData: {
						mimeType: 'image/jpeg',
						data: base64Image,
					},
				});
			}
		} catch (error) {
			console.error('Error processing images:', error.message);
		}
	}

	try {
		const result = await model.generateContent(parts);
		let responseText = result.response.text();

		// 履歴情報を保存する必要がある場合は、レスポンスをパースして履歴情報を抽出
		if (shouldSaveHistory) {
			const parsed = parseAIResponse(responseText);
			
			// 投稿日時から計算した継続日数と運動記録日を使用
			const history = {
				lastTrainingDate: postData.calculatedExerciseDate,
				consecutiveDays: postData.calculatedConsecutiveDays,
				notes: parsed.history?.notes || ''
			};
			
			await saveExerciseHistory(postData.author, history, env);
			
			responseText = parsed.displayText;
		}

		// 簡単な返答の場合は50文字、通常は300文字制限
		const maxLength = isSimpleReply ? 50 : 300;
		if (responseText.length > maxLength) {
			responseText = responseText.substring(0, maxLength);
			const lastPeriod = responseText.lastIndexOf('。');
			if (lastPeriod !== -1) {
				responseText = responseText.substring(0, lastPeriod + 1);
			}
		}

		return responseText;
	} catch (error) {
		console.error('Gemini API error:', error);
		
		// モデルが見つからない場合やAPIエラーの場合
		if (error.message && (error.message.includes('model') || error.message.includes('not found'))) {
			throw new Error('AI_MODEL_NOT_AVAILABLE');
		}
		
		// その他のエラー
		throw error;
	}
}

function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	let binary = '';
	
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return btoa(binary);
}

// 画像をリサイズする関数（アスペクト比を維持）
async function resizeImage(imageBuffer, maxWidth = 400, maxHeight = 400) {
	try {
		// バイト配列からPhotonImageを作成
		const inputImage = PhotonImage.new_from_byteslice(new Uint8Array(imageBuffer));
		
		// 元の画像サイズを取得
		const originalWidth = inputImage.get_width();
		const originalHeight = inputImage.get_height();
		
		// すでに小さい場合はリサイズしない
		if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
			inputImage.free();
			return imageBuffer;
		}
		
		// アスペクト比を維持して新しいサイズを計算
		const aspectRatio = originalWidth / originalHeight;
		let newWidth, newHeight;
		
		if (aspectRatio > maxWidth / maxHeight) {
			newWidth = maxWidth;
			newHeight = Math.round(maxWidth / aspectRatio);
		} else {
			newHeight = maxHeight;
			newWidth = Math.round(maxHeight * aspectRatio);
		}
		
		// リサイズ実行（Nearest: 高速、品質は中程度）
		const outputImage = resize(inputImage, newWidth, newHeight, SamplingFilter.Nearest);
		
		// JPEG形式でエンコード（品質を60に下げて処理時間短縮）
		const outputBytes = outputImage.get_bytes_jpeg(60);
		
		// メモリ解放
		inputImage.free();
		outputImage.free();
		
		return outputBytes.buffer;
	} catch (error) {
		console.error('Image resize failed:', error.message);
		return imageBuffer;
	}
}

// 複数の画像をグリッド化して1枚にまとめる関数
async function createImageGrid(imageBuffers) {
	try {
		const imageCount = imageBuffers.length;
		
		if (imageCount === 1) {
			return imageBuffers[0];
		}
		
		const photonImages = imageBuffers.map(buffer => 
			PhotonImage.new_from_byteslice(new Uint8Array(buffer))
		);
		
		let cols, rows;
		if (imageCount === 2) {
			cols = 2;
			rows = 1;
		} else if (imageCount === 3 || imageCount === 4) {
			cols = 2;
			rows = 2;
		}
		
		// グリッド全体を1200x1200に削減（CPU負荷軽減）
		const maxCellWidth = Math.floor(1200 / cols);
		const maxCellHeight = Math.floor(1200 / rows);
		
		const resizedImages = [];
		for (let i = 0; i < photonImages.length; i++) {
			const img = photonImages[i];
			const originalWidth = img.get_width();
			const originalHeight = img.get_height();
			
			const aspectRatio = originalWidth / originalHeight;
			let newWidth, newHeight;
			
			if (aspectRatio > maxCellWidth / maxCellHeight) {
				newWidth = maxCellWidth;
				newHeight = Math.round(maxCellWidth / aspectRatio);
			} else {
				newHeight = maxCellHeight;
				newWidth = Math.round(maxCellHeight * aspectRatio);
			}
			
			const resizedImg = resize(img, newWidth, newHeight, SamplingFilter.Nearest);
			resizedImages.push({
				image: resizedImg,
				width: newWidth,
				height: newHeight
			});
			
			img.free();
		}
		
		const gridWidth = maxCellWidth * cols;
		const gridHeight = maxCellHeight * rows;
		
		const canvas = new Uint8Array(gridWidth * gridHeight * 4);
		canvas.fill(255);
		
		let imageIndex = 0;
		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				if (imageIndex >= resizedImages.length) break;
				
				const { image, width, height } = resizedImages[imageIndex];
				const rawPixels = image.get_raw_pixels();
				
				const offsetX = col * maxCellWidth + Math.floor((maxCellWidth - width) / 2);
				const offsetY = row * maxCellHeight + Math.floor((maxCellHeight - height) / 2);
				
				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const srcIndex = (y * width + x) * 4;
						const dstIndex = ((offsetY + y) * gridWidth + (offsetX + x)) * 4;
						
						canvas[dstIndex] = rawPixels[srcIndex];
						canvas[dstIndex + 1] = rawPixels[srcIndex + 1];
						canvas[dstIndex + 2] = rawPixels[srcIndex + 2];
						canvas[dstIndex + 3] = rawPixels[srcIndex + 3];
					}
				}
				
				imageIndex++;
			}
		}
		
		const gridImage = new PhotonImage(canvas, gridWidth, gridHeight);
		
		// 品質を60に下げて処理時間短縮
		const outputBytes = gridImage.get_bytes_jpeg(60);
		
		resizedImages.forEach(({ image }) => image.free());
		gridImage.free();
		
		return outputBytes.buffer;
	} catch (error) {
		console.error('Grid creation failed:', error.message);
		return imageBuffers[0];
	}
}

// 処理済みポストのURIを取得
async function getProcessedPosts(env) {
	const processed = new Set();
	
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_posts');
		if (processedData) {
			const posts = JSON.parse(processedData);
			posts.forEach(post => processed.add(post.uri));
		}
	} catch (error) {
		console.error('Error loading processed posts:', error);
	}
	
	return processed;
}

// ポストを処理済みとしてマーク
async function markPostAsProcessed(uri, env) {
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_posts');
		const posts = processedData ? JSON.parse(processedData) : [];
		
		// 新しいポストを追加
		posts.push({
			uri,
			processedAt: new Date().toISOString()
		});
		
		await env.EXERCISE_TRAINER_SESSIONS.put('processed_posts', JSON.stringify(posts));
	} catch (error) {
		console.error('Error marking post as processed:', error);
	}
}

// 7日以上前の処理済み記録を削除
async function cleanupOldProcessedPosts(env) {
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_posts');
		if (!processedData) return;
		
		const posts = JSON.parse(processedData);
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		
		// 7日以内の記録のみ残す
		const recentPosts = posts.filter(post => 
			new Date(post.processedAt) > sevenDaysAgo
		);
		
		if (recentPosts.length !== posts.length) {
			await env.EXERCISE_TRAINER_SESSIONS.put('processed_posts', JSON.stringify(recentPosts));
		}
	} catch (error) {
		console.error('Error cleaning up processed posts:', error);
	}
}

// 最終評価時刻を更新
async function updateLastEvaluationTime(time, env) {
	try {
		await env.EXERCISE_TRAINER_SESSIONS.put('last_evaluation_time', time);
	} catch (error) {
		console.error('Error updating last evaluation time:', error.message);
	}
}

// 最終評価時刻を取得
async function getLastEvaluationTime(env) {
	try {
		const time = await env.EXERCISE_TRAINER_SESSIONS.get('last_evaluation_time');
		return time ? new Date(time) : null;
	} catch (error) {
		console.error('Error getting last evaluation time:', error);
		return null;
	}
}

// 最終リマインダー送信時刻を更新
async function updateLastReminderTime(time, env) {
	try {
		await env.EXERCISE_TRAINER_SESSIONS.put('last_reminder_time', time);
	} catch (error) {
		console.error('Error updating last reminder time:', error.message);
	}
}

// 最終リマインダー送信時刻を取得
async function getLastReminderTime(env) {
	try {
		const time = await env.EXERCISE_TRAINER_SESSIONS.get('last_reminder_time');
		return time ? new Date(time) : null;
	} catch (error) {
		console.error('Error getting last reminder time:', error);
		return null;
	}
}

// リマインダーが必要かチェックして送信
async function checkAndSendReminder(env, bsky) {
	try {
		const now = new Date();
		const lastEvaluationTime = await getLastEvaluationTime(env);
		const lastReminderTime = await getLastReminderTime(env);
		
		if (!lastEvaluationTime) {
			return;
		}
		
		const hoursSinceEvaluation = (now - lastEvaluationTime) / (1000 * 60 * 60);
		
		const initialHours = parseFloat(env.REMINDER_INITIAL_HOURS) || 72;
		if (hoursSinceEvaluation < initialHours) {
			return;
		}
		
		if (lastReminderTime) {
			const hoursSinceReminder = (now - lastReminderTime) / (1000 * 60 * 60);
			
			const intervalHours = parseFloat(env.REMINDER_INTERVAL_HOURS) || 24;
			if (hoursSinceReminder < intervalHours) {
				return;
			}
		}
		
		const reminderText = await generateReminderMessage(env, hoursSinceEvaluation);
		
		const profile = await bsky.getProfile(env.CHECK_BSKY_DID);
		const handle = profile.data.handle;
		
		const messageWithMention = `@${handle} ${reminderText}`;
		await bsky.postText(messageWithMention);
		
		await updateLastReminderTime(now.toISOString(), env);
	} catch (error) {
		console.error('Error checking and sending reminder:', error.message);
	}
}

// リマインダーメッセージを生成
async function generateReminderMessage(env, hoursSinceEvaluation) {
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
	const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';
	
	let model;
	try {
		model = genAI.getGenerativeModel({ model: modelName });
	} catch (error) {
		console.error('Failed to get AI model:', error);
		// フォールバック: シンプルなメッセージを返す
		return 'お久しぶりです！最近お身体の調子はいかがですか？無理のない範囲で、また一緒にトレーニングしましょう！';
	}

	// 日本時間を取得して時間帯を判定
	const jstDate = getJSTDate();
	const timeOfDay = getTimeOfDay(jstDate);
	const formattedTime = jstDate.toLocaleString('ja-JP', { hour12: false });
	const daysSince = Math.floor(hoursSinceEvaluation / 24);

	const prompt = `${REMINDER_RULES}\n\n最後の運動から約${daysSince}日が経過しています。\n現在の日時: ${formattedTime}\n時間帯: ${timeOfDay}\n\n体調を気遣いながら、無理のない範囲で声をかけるメッセージを生成してください。`;

	try {
		const result = await model.generateContent(prompt);
		let responseText = result.response.text();

		// 300文字制限
		if (responseText.length > 300) {
			responseText = responseText.substring(0, 300);
			const lastPeriod = responseText.lastIndexOf('。');
			if (lastPeriod !== -1) {
				responseText = responseText.substring(0, lastPeriod + 1);
			}
		}

		return responseText;
	} catch (error) {
		console.error('Gemini API error for reminder:', error);
		// フォールバック: シンプルなメッセージを返す
		return 'お久しぶりです！最近お身体の調子はいかがですか？無理のない範囲で、また一緒にトレーニングしましょう！';
	}
}

// Botへの通知（メンション/リプライ）を処理
async function handleNotifications(env, bsky) {
	try {
		// 通知取得も制限を削減
		const notifications = await bsky.getNotifications({ limit: 20 });
		
		if (!notifications || !notifications.data || !notifications.data.notifications || !Array.isArray(notifications.data.notifications)) {
			return;
		}
		
		const processedNotifications = await getProcessedNotifications(env);
		
		let newNotificationsCount = 0;
		
		for (const notification of notifications.data.notifications) {
			// mention または reply のみ処理
			if (notification.reason !== 'mention' && notification.reason !== 'reply') {
				continue;
			}
			
			// CHECK_BSKY_DIDからの通知のみ処理
			if (notification.author.did !== env.CHECK_BSKY_DID) {
				continue;
			}
			
			// 既に処理済みの通知はスキップ
			if (processedNotifications.has(notification.uri)) {
				continue;
			}
			
			try {
				// スレッド情報を取得してroot参照を正しく設定し、会話の文脈を判断
				let rootUri = null;
				let rootCid = null;
				let isReplyToBot = false;
				
				const threadInfo = await bsky.getPostThread(notification.uri);
				if (threadInfo && threadInfo.data && threadInfo.data.thread) {
					const thread = threadInfo.data.thread;
					
					// スレッドのrootを取得
					if (thread.post && thread.post.record && thread.post.record.reply) {
						// この投稿自体がリプライの場合、rootを使用
						rootUri = thread.post.record.reply.root.uri;
						rootCid = thread.post.record.reply.root.cid;
						
						// リプライ先（parent）の投稿者を確認
						if (thread.parent && thread.parent.post && thread.parent.post.author) {
							const parentAuthorDid = thread.parent.post.author.did;
							const botDid = bsky.agent.session?.did;
							
							// リプライ先がボット自身の投稿なら会話の続き
							if (botDid && parentAuthorDid === botDid) {
								isReplyToBot = true;
							}
						}
					}
				}
				
				let responseText;
				
				// 投稿データを準備
				const postData = {
					text: notification.record.text,
					created_at: notification.record.createdAt,
					author: notification.author.did,
					uri: notification.uri,
				};
				
				// 画像URLを取得
				if (notification.record.embed?.images) {
					postData.images = notification.record.embed.images.map(img => img.fullsize);
				}
				
				try {
					// ボットへのリプライ（会話の続き）なら簡単な返答を生成
					if (isReplyToBot) {
						responseText = await analyzeWithGemini(postData, env, true);
					} else {
						// 初回のメンションなら通常の評価
						responseText = await analyzeWithGemini(postData, env, false);
					}
				} catch (error) {
					// AIモデルが使用できない場合の専用メッセージ
					if (error.message === 'AI_MODEL_NOT_AVAILABLE') {
						const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';
						responseText = `申し訳ございません。現在使用しているAIモデル（${modelName}）が利用できなくなっています。\n\nボットの管理者に連絡し、AIモデルの設定を更新する必要があります。しばらくお待ちください。`;
						console.error('AI model not available:', modelName);
					} else {
						throw error;
					}
				}
				
				await bsky.postReply(responseText, notification.uri, notification.cid, rootUri, rootCid);
				
				// 処理完了後、KVに記録
				await markNotificationAsProcessed(notification.uri, env);
				newNotificationsCount++;
				
			} catch (error) {
				console.error('Error processing notification:', error);
			}
		}
		
		// 10回に1回だけクリーンアップを実行
		const shouldCleanup = Math.random() < 0.1;
		if (shouldCleanup) {
			await cleanupOldProcessedNotifications(env);
		}
	} catch (error) {
		console.error('Error handling notifications:', error.message);
	}
}

// 処理済み通知のURIを取得
async function getProcessedNotifications(env) {
	const processed = new Set();
	
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_notifications');
		if (processedData) {
			const notifications = JSON.parse(processedData);
			notifications.forEach(notification => processed.add(notification.uri));
		}
	} catch (error) {
		console.error('Error loading processed notifications:', error);
	}
	
	return processed;
}

// 通知を処理済みとしてマーク
async function markNotificationAsProcessed(uri, env) {
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_notifications');
		const notifications = processedData ? JSON.parse(processedData) : [];
		
		// 新しい通知を追加
		notifications.push({
			uri,
			processedAt: new Date().toISOString()
		});
		
		await env.EXERCISE_TRAINER_SESSIONS.put('processed_notifications', JSON.stringify(notifications));
	} catch (error) {
		console.error('Error marking notification as processed:', error);
	}
}

// 7日以上前の処理済み通知記録を削除
async function cleanupOldProcessedNotifications(env) {
	try {
		const processedData = await env.EXERCISE_TRAINER_SESSIONS.get('processed_notifications');
		if (!processedData) return;
		
		const notifications = JSON.parse(processedData);
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		
		// 7日以内の記録のみ残す
		const recentNotifications = notifications.filter(notification => 
			new Date(notification.processedAt) > sevenDaysAgo
		);
		
		if (recentNotifications.length !== notifications.length) {
			await env.EXERCISE_TRAINER_SESSIONS.put('processed_notifications', JSON.stringify(recentNotifications));
		}
	} catch (error) {
		console.error('Error cleaning up processed notifications:', error);
	}
}

// ユーザーの運動履歴を取得
async function getExerciseHistory(did, env) {
	try {
		const key = `exercise_history_${did}`;
		const historyData = await env.EXERCISE_TRAINER_SESSIONS.get(key);
		
		if (historyData) {
			return JSON.parse(historyData);
		}
		
		// 履歴がない場合は空のオブジェクトを返す
		return {
			lastTrainingDate: null,
			consecutiveDays: 0,
			notes: ''
		};
	} catch (error) {
		console.error('Error getting exercise history:', error.message);
		return {
			lastTrainingDate: null,
			consecutiveDays: 0,
			notes: ''
		};
	}
}

async function saveExerciseHistory(did, history, env) {
	try {
		const key = `exercise_history_${did}`;
		await env.EXERCISE_TRAINER_SESSIONS.put(key, JSON.stringify(history));
	} catch (error) {
		console.error('Error saving exercise history:', error.message);
	}
}

// AI応答から履歴情報を抽出
function parseAIResponse(responseText) {
	const parts = responseText.split('---');
	
	if (parts.length < 2) {
		// 履歴情報がない場合はそのまま返す
		return {
			displayText: responseText.trim(),
			history: null
		};
	}
	
	const displayText = parts[0].trim();
	const historyText = parts.slice(1).join('---').trim();
	
	// 履歴情報をパース（その他の観察事項のみ）
	const history = {
		notes: ''
	};
	
	const lines = historyText.split('\n');
	for (const line of lines) {
		const trimmedLine = line.trim();
		
		// その他の観察事項を抽出
		const notesMatch = trimmedLine.match(/その他[：:]\s*(.+)/);
		if (notesMatch) {
			history.notes = notesMatch[1].trim();
		}
	}
	
	return {
		displayText,
		history
	};
}
