import { BskyAgent, RichText } from '@atproto/api';

export class BlueskyUtil {
	constructor(env) {
		this.env = env;
		this.agent = new BskyAgent({
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
			console.log('Trying to reload session...');
			const sessionStr = await this.env.EXERCISE_TRAINER_SESSIONS.get('bsky_session');
			
			if (sessionStr) {
				const session = JSON.parse(sessionStr);
				await this.agent.resumeSession(session);
				console.log('Session loaded successfully');
				return true;
			}
		} catch (error) {
			console.log('Failed to load session:', error.message);
		}
		
		return await this.createSession();
	}

	async createSession() {
		try {
			console.log('Creating new session...');
			await this.agent.login({
				identifier: this.env.BSKY_USER_NAME,
				password: this.env.BSKY_APP_PASS,
			});
			await this.saveSession();
			console.log('New session created');
			return true;
		} catch (error) {
			console.error('Failed to create session:', error);
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

	async postReply(text, replyToUri, replyToCid) {
		const rt = new RichText({ text });
		await rt.detectFacets(this.agent);

		const parentRef = {
			uri: replyToUri,
			cid: replyToCid,
		};

		return await this.agent.post({
			text: rt.text,
			facets: rt.facets,
			reply: {
				root: parentRef,
				parent: parentRef,
			},
		});
	}

	async searchPosts({ query, limit = 20, author = null, since = null, until = null }) {
		const params = { q: query, limit };
		
		if (author) params.author = author;
		if (since) params.since = since;
		if (until) params.until = until;

		console.log('Search params:', params);

		return await this.agent.app.bsky.feed.searchPosts(params);
	}

	async getProfile(did) {
		return await this.agent.getProfile({ actor: did });
	}
}
