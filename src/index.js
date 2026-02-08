import { BlueskyUtil } from './bluesky-util.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';

const RULES = `# Gemini 回答生成ルール

あなたはプロのフィットネストレーナーであり、Blueskyに投稿するボットです。
**最重要ルール：生成するテキストは、絶対に300文字以内に収めてください。**
これはBlueskyのシステム的な文字数制限であり、超えると投稿が途中で切り捨てられ、非常に不自然になります。このルールは他のどの指示よりも優先されます。

## 回答の構成

1.  **採点（xx点）：** 最初に100点満点で採点結果を提示します。
2.  **褒め言葉:** トレーニングの良い点を1つ、具体的に褒めます。
3.  **応援メッセージ:** 現在の日時に応じた短い励ましの言葉で締めくくります。平日と休日は区別してください。

## 採点基準

-   画像から読み取れるスコアよりも運動している時間と継続日数を重点的に評価します。
-   以下の基準で点数をつけ、内容に応じて調整してください。
    -   100点: 運動時間が30分以上、継続日数が3日以上
    -   90点: 運動時間が30分以上、継続日数が2日以上
    -   80点: 運動時間が30分以上、継続日数が1日以上
    -   70点: 運動時間が30分以上、継続日数が1日未満
-   1週間のうち1,2日程度の休みであれば休息日として評価、継続しているものとしてください。

## スタイル

-   常にポジティブで、モチベーションを高めるトーンを維持してください。
-   ハッシュタグ（#）は絶対に含めないでください。
-   専門用語を避け、誰にでも分かりやすい言葉で説明してください。
-   「現在の日時」は現地時間で24時間表記です。
-   「現在の日時」が朝の時間帯の投稿であれば、その日の活力を引き出すような内容にしてください。
-   「現在の日時」が昼の時間帯の投稿であれば、午後の活力を引き出すような内容にしてください。
-   「現在の日時」が夜の時間帯の投稿であれば、一日の疲れを労うような内容にしてください。
-   「現在の日時」を内容に含める必要はありません。
-   文面から当日2回目以降のエクササイズだと読み取れる場合、評価を高めにしてください。
-   画像内のスコアは中途半端でも最高得点であることがあります。改善点には含めないようにしてください。
-   文面から体調不良などの理由が読み取れる場合、マイナス評価せず、再開したことを褒めてください。
-   休息日を設けず1週間以上継続している場合、休息日を提案してください。
-   過剰なトレーニングなど誤った箇所があれば指摘してください。
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

	console.log('Searching posts:', { since, until });

	const posts = await bsky.searchPosts({
		query: '#青空筋トレ部',
		limit: 50, // 24時間分なので増加
		author: env.CHECK_BSKY_DID,
		since,
		until,
	});

	// APIレスポンスの構造を修正: posts.data.posts
	if (!posts || !posts.data || !posts.data.posts || !Array.isArray(posts.data.posts)) {
		console.log('No posts found or invalid response structure');
		return;
	}

	console.log('Found posts:', posts.data.posts.length);

	// 処理済みポストのURIを取得
	const processedPosts = await getProcessedPosts(env);
	console.log('Previously processed posts:', processedPosts.size);

	let newPostsCount = 0;
	for (const post of posts.data.posts) {
		// 既に処理済みのポストはスキップ
		if (processedPosts.has(post.uri)) {
			console.log('Skipping already processed post:', post.uri);
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
			
			console.log('Replied to post:', post.uri);
		} catch (error) {
			console.error('Error processing post:', error);
		}
	}
	
	console.log('Processed new posts:', newPostsCount);
	
	// 古い処理済み記録をクリーンアップ（7日以上前の記録を削除）
	await cleanupOldProcessedPosts(env);
}

async function analyzeWithGemini(postData, env) {
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
	const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash';
	
	let model;
	try {
		model = genAI.getGenerativeModel({ model: modelName });
	} catch (error) {
		console.error('Failed to get AI model:', error);
		throw new Error('AI_MODEL_NOT_AVAILABLE');
	}

	const now = new Date();
	const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const formattedTime = jstTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

	const prompt = `${RULES}\n\n# 投稿内容:\n${postData.text}\n\n現在の日時: ${formattedTime}\n\n`;

	// 画像がある場合は画像も含めて送信
	const parts = [{ text: prompt }];
	
	if (postData.images && postData.images.length > 0) {
		for (const imageUrl of postData.images) {
			try {
				const imageResponse = await fetch(imageUrl);
				const imageBuffer = await imageResponse.arrayBuffer();
				
				// 画像をリサイズ（640x360以内に）
				const resizedBuffer = await resizeImage(imageBuffer);
				const base64Image = arrayBufferToBase64(resizedBuffer);
				
				parts.push({
					inlineData: {
						mimeType: 'image/jpeg',
						data: base64Image,
					},
				});
			} catch (error) {
				console.error('Error loading image:', error);
			}
		}
	}

	try {
		const result = await model.generateContent(parts);
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
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

// 画像をリサイズする関数（アスペクト比を維持）
async function resizeImage(imageBuffer, maxWidth = 640, maxHeight = 360) {
	try {
		// バイト配列からPhotonImageを作成
		const inputImage = PhotonImage.new_from_byteslice(new Uint8Array(imageBuffer));
		
		// 元の画像サイズを取得
		const originalWidth = inputImage.get_width();
		const originalHeight = inputImage.get_height();
		
		// すでに小さい場合はリサイズしない
		if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
			console.log(`Image already small enough: ${originalWidth}x${originalHeight}`);
			inputImage.free(); // メモリ解放
			return imageBuffer;
		}
		
		// アスペクト比を維持して新しいサイズを計算
		const aspectRatio = originalWidth / originalHeight;
		let newWidth, newHeight;
		
		if (aspectRatio > maxWidth / maxHeight) {
			// 横長: 幅を基準にリサイズ
			newWidth = maxWidth;
			newHeight = Math.round(maxWidth / aspectRatio);
		} else {
			// 縦長: 高さを基準にリサイズ
			newHeight = maxHeight;
			newWidth = Math.round(maxHeight * aspectRatio);
		}
		
		console.log(`Resizing image from ${originalWidth}x${originalHeight} to ${newWidth}x${newHeight}`);
		
		// リサイズ実行（Nearest: 高速、品質は中程度）
		const outputImage = resize(inputImage, newWidth, newHeight, SamplingFilter.Nearest);
		
		// JPEG形式でエンコード（品質80）
		const outputBytes = outputImage.get_bytes_jpeg(80);
		
		// メモリ解放
		inputImage.free();
		outputImage.free();
		
		return outputBytes.buffer;
	} catch (error) {
		console.error('Image resize failed, using original:', error);
		// リサイズ失敗時は元の画像を返す
		return imageBuffer;
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
