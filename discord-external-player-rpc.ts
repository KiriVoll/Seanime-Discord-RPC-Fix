/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

type ExtRpcPlaybackData = {
    mediaId: number;
    episodeNumber: number;
    title: string;
    image: string;
    isMovie: boolean;
    totalEpisodes: number;
};

function init() {
    const STORE_KEY = "ext_rpc_playback";

    // 🚀 ГЛАВНЫЙ ТРИГГЕР — запуск external player
    $app.onExternalPlayerLaunch((e) => {
        if (!e || !e.media || !e.mediaId) {
            e.next();
            return;
        }

        const media = e.media;

        $store.set(STORE_KEY, {
            mediaId: e.mediaId,
            episodeNumber: e.episodeNumber || 1,
            title: media.title?.userPreferred || media.title?.romaji || media.title?.english || "Unknown",
            image: media.coverImage?.extraLarge || media.coverImage?.large || "",
            isMovie: media.format === "MOVIE",
            totalEpisodes: media.episodes || 0,
        } satisfies ExtRpcPlaybackData);

        e.next();
    });

    $ui.register((ctx) => {
        let discordActive = false;
        let stopTimeout: any = null;

        function stopDiscord() {
            if (stopTimeout) {
                clearTimeout(stopTimeout);
                stopTimeout = null;
            }

            if (discordActive) {
                try {
                    ctx.discord.cancel();
                } catch {}
            }

            discordActive = false;
        }

        function startDiscord(data: ExtRpcPlaybackData) {
            stopDiscord();

            try {
                ctx.discord.setAnimeActivity({
                    id: data.mediaId,
                    title: data.title,
                    image: data.image,
                    isMovie: data.isMovie,
                    episodeNumber: data.episodeNumber,
                    progress: 0,
                    duration: 0, // ❗ ключ: показываем просто факт, без времени
                    totalEpisodes: data.totalEpisodes > 0 ? data.totalEpisodes : undefined,
                });

                discordActive = true;
            } catch (err) {
                console.error("[Ext RPC] Failed to start Discord:", err);
                return;
            }

            // ❗ авто-стоп через 2 часа (на всякий)
            stopTimeout = setTimeout(() => {
                stopDiscord();
            }, 2 * 60 * 60 * 1000);
        }

        // 🔥 СРАЗУ стартуем при получении события
        $store.watch<ExtRpcPlaybackData>(STORE_KEY, (data) => {
            if (!data) return;

            startDiscord(data);
        });
    });
}

export {};
