export interface YouTubeLink { id: string; url: string; startSeconds: number }
export function youtubeLinks(text: string): YouTubeLink[];
