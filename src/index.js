import { BlueskyUtil } from './bluesky-util.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

	// 現在時刻を5分単位に丸めて、5分前と10分前を計算
	const now = new Date();
	const nowRounded = new Date(now);
	nowRounded.setMinutes(Math.floor(now.getMinutes() / 5) * 5, 0, 0);
	
	const since = new Date(nowRounded.getTime() - 12 * 60 * 60 * 1000).toISOString();
	const until = nowRounded.toISOString();

	console.log('Searching posts:', { since, until });

	const posts = await bsky.searchPosts({
		query: '#青空筋トレ部',
		limit: 10,
		author: env.CHECK_BSKY_DID,
		since,
		until,
	});

	console.log('Found posts:', posts.posts.length);

	for (const post of posts.posts) {
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

			const responseText = await analyzeWithGemini(postData, env);
			await bsky.postReply(responseText, post.uri, post.cid);
			
			console.log('Replied to post:', post.uri);
		} catch (error) {
			console.error('Error processing post:', error);
		}
	}
}

async function analyzeWithGemini(postData, env) {
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
	const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp-lite' });

	const now = new Date();
	const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	const formattedTime = jstTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

	const prompt = `${RULES}\n\n# 投稿内容:\n${postData.text}\n\n現在の日時: ${formattedTime}\n\n`;

	console.log('--- Prompt for Gemini ---');
	console.log(prompt);

	// 画像がある場合は画像も含めて送信
	const parts = [{ text: prompt }];
	
	if (postData.images && postData.images.length > 0) {
		for (const imageUrl of postData.images) {
			try {
				const imageResponse = await fetch(imageUrl);
				const imageBuffer = await imageResponse.arrayBuffer();
				const base64Image = arrayBufferToBase64(imageBuffer);
				
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

	console.log('--- Gemini Response ---');
	console.log(responseText);

	return responseText;
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
