import { AtpAgent, RichText } from '@atproto/api';

export class BlueskyUtil {
	constructor(env) {
		this.env = env;
		this.pendingSessionWrite = Promise.resolve();
		// KVに保存済みのトークン（変更がなければ書き込みを省略するために使う）
		this.persistedTokens = null;
		this.agent = new AtpAgent({
			service: 'https://bsky.social',
			// トークンのリフレッシュ時にも最新のセッションをKVへ保存する
			persistSession: (evt, session) => this.handleSessionEvent(evt, session),
		});
	}

	handleSessionEvent(evt, session) {
		let write;
		if ((evt === 'create' || evt === 'update') && session) {
			// resumeSession は成功するたびに 'update' を通知するため、
			// トークンが変わっていない場合はKVへの書き込みを省略する（KVの書き込み上限対策）
			if (this.isPersisted(session)) {
				return;
			}
			const sessionStr = JSON.stringify(session);
			this.persistedTokens = { accessJwt: session.accessJwt, refreshJwt: session.refreshJwt };
			write = () => this.env.EXERCISE_TRAINER_SESSIONS.put('bsky_session', sessionStr);
		} else if (evt === 'expired') {
			this.persistedTokens = null;
			write = () => this.env.EXERCISE_TRAINER_SESSIONS.delete('bsky_session');
		} else {
			return;
		}

		// 書き込み順を保証するために直列化する
		this.pendingSessionWrite = this.pendingSessionWrite
			.then(write)
			.catch((error) => console.error('Failed to persist session:', error.message));
	}

	isPersisted(session) {
		return !!this.persistedTokens
			&& this.persistedTokens.accessJwt === session.accessJwt
			&& this.persistedTokens.refreshJwt === session.refreshJwt;
	}

	// 未完了のセッション保存を待つ（Worker終了前に呼ぶ）
	async flushSession() {
		await this.pendingSessionWrite;
	}

	async loadSession() {
		try {
			const sessionStr = await this.env.EXERCISE_TRAINER_SESSIONS.get('bsky_session');
			
			if (sessionStr) {
				const session = JSON.parse(sessionStr);
				// resumeSession はリフレッシュ時に session を直接書き換えるため、読み込み時点の値を控えておく
				this.persistedTokens = { accessJwt: session.accessJwt, refreshJwt: session.refreshJwt };
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
