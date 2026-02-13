import { BlueskyUtil } from './bluesky-util.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';

/**
 * 日本時間（JST）のDateオブジェクトを取得
 * @returns {Date} 日本時間のDateオブジェクト
 */
function getJSTDate() {
	const now = new Date();
	// 日本時間に変換（UTC+9時間）
	return new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
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
		// 投稿がない場合でもリマインダーチェックを実行
		await checkAndSendReminder(env, bsky);
		return;
	}

	console.log('Found posts:', posts.data.posts.length);

	// 処理済みポストのURIを取得
	const processedPosts = await getProcessedPosts(env);
	console.log('Previously processed posts:', processedPosts.size);

	let newPostsCount = 0;
	let latestPostTime = null;
	
	// ハッシュタグ付き投稿の処理
	
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
			
			// 最新の投稿時刻を記録
			const postTime = new Date(postData.created_at);
			if (!latestPostTime || postTime > latestPostTime) {
				latestPostTime = postTime;
			}
			
			console.log('Replied to post:', post.uri);
		} catch (error) {
			console.error('Error processing post:', error);
		}
	}
	
	console.log('Processed new posts:', newPostsCount);
	
	// 新しい投稿を処理した場合、最終評価時刻を更新
	if (latestPostTime) {
		await updateLastEvaluationTime(latestPostTime.toISOString(), env);
	}
	
	// 古い処理済み記録をクリーンアップ（7日以上前の記録を削除）
	await cleanupOldProcessedPosts(env);
	
	// Botへの通知（メンション/リプライ）を処理
	await handleNotifications(env, bsky);
	
	// リマインダーのチェックと送信
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
	if (isSimpleReply) {
		prompt = `あなたはフレンドリーなフィットネストレーナーです。ユーザーの返信に対して、30文字程度の自然で簡潔な返答をしてください。

# ユーザーのメッセージ:
${postData.text}

現在の日時: ${formattedTime}

※ルールに従った評価は不要です。会話を続けようとせず、感謝や応援の気持ちを伝える簡潔な返答をしてください。`;
	} else {
		prompt = `${RULES}\n\n# 投稿内容:\n${postData.text}\n\n現在の日時: ${formattedTime}\n時間帯: ${timeOfDay}\n\n`;
	}

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

// 最終評価時刻を更新
async function updateLastEvaluationTime(time, env) {
	try {
		await env.EXERCISE_TRAINER_SESSIONS.put('last_evaluation_time', time);
		console.log('Updated last evaluation time:', time);
	} catch (error) {
		console.error('Error updating last evaluation time:', error);
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
		console.log('Updated last reminder time:', time);
	} catch (error) {
		console.error('Error updating last reminder time:', error);
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
		
		// 最終評価時刻がない場合は何もしない（初回実行時など）
		if (!lastEvaluationTime) {
			console.log('No last evaluation time found, skipping reminder check');
			return;
		}
		
		const hoursSinceEvaluation = (now - lastEvaluationTime) / (1000 * 60 * 60);
		console.log(`Hours since last evaluation: ${hoursSinceEvaluation.toFixed(2)}`);
		
		const initialHours = parseFloat(env.REMINDER_INITIAL_HOURS) || 72;
		// 初回リマインダーの時間経過していない場合は何もしない
		if (hoursSinceEvaluation < initialHours) {
			console.log(`Less than ${initialHours} hours since last evaluation, no reminder needed`);
			return;
		}
		
		// リマインダーを送信済みの場合、指定時間経過しているかチェック
		if (lastReminderTime) {
			const hoursSinceReminder = (now - lastReminderTime) / (1000 * 60 * 60);
			console.log(`Hours since last reminder: ${hoursSinceReminder.toFixed(2)}`);
			
			const intervalHours = parseFloat(env.REMINDER_INTERVAL_HOURS) || 24;
			if (hoursSinceReminder < intervalHours) {
				console.log(`Less than ${intervalHours} hours since last reminder, skipping`);
				return;
			}
		}
		
		// リマインダーメッセージを生成して送信
		console.log('Sending reminder message...');
		const reminderText = await generateReminderMessage(env, hoursSinceEvaluation);
		
		// ユーザーの最新投稿を取得してリプライとして送信
		// （リプライ先がない場合は通常投稿として送信）
		const profile = await bsky.getProfile(env.CHECK_BSKY_DID);
		const handle = profile.data.handle;
		
		// @ハンドルをつけて投稿
		const messageWithMention = `@${handle} ${reminderText}`;
		await bsky.postText(messageWithMention);
		
		// 最終リマインダー送信時刻を更新
		await updateLastReminderTime(now.toISOString(), env);
		console.log('Reminder sent successfully');
	} catch (error) {
		console.error('Error checking and sending reminder:', error);
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
		console.log('Checking notifications...');
		
		// 通知を取得
		const notifications = await bsky.getNotifications({ limit: 50 });
		
		if (!notifications || !notifications.data || !notifications.data.notifications || !Array.isArray(notifications.data.notifications)) {
			console.log('No notifications found or invalid response structure');
			return;
		}
		
		console.log('Found notifications:', notifications.data.notifications.length);
		
		// 処理済み通知のURIを取得
		const processedNotifications = await getProcessedNotifications(env);
		console.log('Previously processed notifications:', processedNotifications.size);
		
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
				console.log('Skipping already processed notification:', notification.uri);
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
						console.log('Simple reply to conversation:', notification.uri);
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
				
				console.log('Replied to notification:', notification.uri);
			} catch (error) {
				console.error('Error processing notification:', error);
			}
		}
		
		console.log('Processed new notifications:', newNotificationsCount);
		
		// 処理済み通知の記録をクリーンアップ（7日以上前の記録を削除）
		await cleanupOldProcessedNotifications(env);
	} catch (error) {
		console.error('Error handling notifications:', error);
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
