/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import JSZip from 'jszip';

const mimeTypes = {
	'txt': 'text/plain',
	'html': 'text/html',
	'css': 'text/css',
	'js': 'application/javascript',
	'json': 'application/json',
	'png': 'image/png',
	'jpg': 'image/jpeg',
	'jpeg': 'image/jpeg',
	'gif': 'image/gif',
	'pdf': 'application/pdf',
	'svg': 'image/svg+xml',
	'sh': 'application/x-sh',
	'conf': 'text/plain',
	'rasi': 'text/rasi',
	'qml': 'text/x-qml',
	'csv': 'text/csv',
	'xml': 'application/xml'
};

function getMimeType(filename) {
	const ext = filename.split('.').pop().toLowerCase();
	return mimeTypes[ext] || 'text/plain';
}

async function extractZip(zipArrayBuffer, prefix) {
	const zip = await JSZip.loadAsync(zipArrayBuffer);
	const fileEntries = [];

	for (const [filename, file] of Object.entries(zip.files)) {
		if (!file.dir) {
			const content = await file.async('uint8array');
			const newFilename = filename.replace(new RegExp(`^${prefix}/`), '');
			const mimeType = getMimeType(newFilename);

			console.log(`Processing file: ${newFilename}, size: ${content.length}, MIME type: ${mimeType}`);
			fileEntries.push({ name: newFilename, content, mimeType });
		}
	}

	return fileEntries;
}

function authorizeRequest(request, env) {
	const validMethods = ['PUT', 'DELETE'];
	return request.method === 'GET' || (validMethods.includes(request.method) && request.headers.get('X-Custom-Auth-Key') === env.AUTH_KEY_SECRET);
}

export default {
	async fetch(request, env, ctx) {
		const { GITHUB_USER: user, GITHUB_REPO: repo, GITHUB_BRANCH: branch = 'main' } = env;
		const url = new URL(request.url);
		const key = url.pathname.slice(1);

		if (url.pathname === '/') {
			const scriptContent = `#!/bin/bash
			sudo pacman -S --noconfirm --needed git
			git clone https://github.com/${user}/${repo}.git -b ${branch}
			cd ${repo}
			chmod +x ./install.sh
			./install.sh
			cd ..
			rm -rf ${repo}
			`;

			return new Response(scriptContent, {
				headers: {
					'Content-Type': 'text/x-shellscript',
					'Content-Disposition': 'attachment; filename="install.sh"',
				},
			});
		}

		if (!authorizeRequest(request, env)) return new Response('Forbidden', { status: 403 });

		try {
			switch (request.method) {
				case 'PUT':
					await env.R2_BUCKET.put(key, request.body);
					return new Response(`Put ${key} successfully!`);
				case 'GET':
					const object = await env.R2_BUCKET.get(key);
					if (!object) return new Response('Object Not Found', { status: 404 });

					const headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set('etag', object.httpEtag);

					return new Response(object.body, { headers });
				case 'DELETE':
					await env.R2_BUCKET.delete(key);
					return new Response('Deleted!');
				default:
					return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'PUT, GET, DELETE' } });
			}
		} catch (error) {
			console.error('Error processing request:', error.message);
			return new Response('Internal Server Error', { status: 500 });
		}
	},

	async scheduled(event, env, ctx) {
		const { GITHUB_USER: user, GITHUB_REPO: repo, GITHUB_BRANCH: branch = 'main' } = env;
		const prefix = `${repo}-${branch}`;
		const zipUrl = `https://github.com/${user}/${repo}/archive/refs/heads/${branch}.zip`;

		try {
			const response = await fetch(zipUrl);
			if (!response.ok) throw new Error(`Failed to fetch ZIP file: ${response.statusText}`);

			const zipArrayBuffer = await response.arrayBuffer();
			const files = await extractZip(zipArrayBuffer, prefix);

			await Promise.all(files.map(file =>
				env.R2_BUCKET.put(file.name, file.content, { contentType: file.mimeType })
					.then(() => console.log(`Successfully saved ${file.name} to R2`))
			));
		} catch (error) {
			console.error('Error processing ZIP file:', error.message);
			throw error;
		}
	}
};
