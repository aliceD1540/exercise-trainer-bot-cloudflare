import { AtpAgent, RichText } from '@atproto/api';

export class BlueskyUtil {
	constructor(env) {
		this.env = env;
		this.agent = new AtpAgent({
			service: 'https://bsky.social',
		});
	}

	async saveSession() {
		const session = this.agent.session;
		if (session) {
			await this.env.EXERCISE_TRAINER_SESSIONS.put('bsky_session', JSON.stringify(session));
		}
	}

	async loadSession() {
		try {
			const sessionStr = await this.env.EXERCISE_TRAINER_SESSIONS.get('bsky_session');
			
			if (sessionStr) {
				const session = JSON.parse(sessionStr);
				await this.agent.resumeSession(session);
				return true;
			}
		} catch (error) {
			console.error('Failed to load session:', error.message);
		}
		
		return await this.createSession();
	}

	async createSession() {
		try {
			await this.agent.login({
				identifier: this.env.BSKY_USER_NAME,
				password: this.env.BSKY_APP_PASS,
			});
			await this.saveSession();
			return true;
		} catch (error) {
			console.error('Failed to create session:', error.message);
			return false;
		}
	}

	async postText(text) {
		const rt = new RichText({ text });
		await rt.detectFacets(this.agent);
		
		return await this.agent.post({
			text: rt.text,
			facets: rt.facets,
		});
	}

	async postReply(text, replyToUri, replyToCid, rootUri = null, rootCid = null) {
		const rt = new RichText({ text });
		await rt.detectFacets(this.agent);

		const parentRef = {
			uri: replyToUri,
			cid: replyToCid,
		};

		// rootが指定されていない場合は、parentと同じとする（最上位投稿へのリプライ）
		const rootRef = (rootUri && rootCid) ? {
			uri: rootUri,
			cid: rootCid,
		} : parentRef;

		return await this.agent.post({
			text: rt.text,
			facets: rt.facets,
			reply: {
				root: rootRef,
				parent: parentRef,
			},
		});
	}

	async searchPosts({ query, limit = 20, author = null, since = null, until = null }) {
		const params = { q: query, limit };
		
		if (author) params.author = author;
		if (since) params.since = since;
		if (until) params.until = until;

		try {
			const result = await this.agent.app.bsky.feed.searchPosts(params);
			return result;
		} catch (error) {
			console.error('Search posts error:', error.message);
			return { data: { posts: [] } };
		}
	}

	async getProfile(did) {
		return await this.agent.getProfile({ actor: did });
	}

	// 通知（メンション/リプライ）を取得
	async getNotifications({ limit = 50, seenAt = null }) {
		try {
			const params = { limit };
			if (seenAt) {
				params.seenAt = seenAt;
			}
			
			const result = await this.agent.listNotifications(params);
			return result;
		} catch (error) {
			console.error('Get notifications error:', error.message);
			return { data: { notifications: [] } };
		}
	}

	// 通知を既読にする
	async updateSeenNotifications() {
		try {
			await this.agent.updateSeenNotifications();
		} catch (error) {
			console.error('Update seen notifications error:', error.message);
		}
	}

	// 投稿のスレッド情報を取得
	async getPostThread(uri) {
		try {
			const result = await this.agent.getPostThread({ uri, depth: 0 });
			return result;
		} catch (error) {
			console.error('Get post thread error:', error.message);
			return null;
		}
	}
}
