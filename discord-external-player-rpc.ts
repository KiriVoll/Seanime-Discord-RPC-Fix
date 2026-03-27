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
    durationSeconds: number;
    triggeredAt: number;
};

function init() {
    const STORE_PLAYBACK_KEY = "ext_rpc_playback";
    const STORE_STD_TRACKING_TS = "ext_rpc_std_tracking_ts";

    $app.onPlaybackLocalFileDetailsRequested((e) => {
        if (!e.localFile || !e.animeListEntry || !e.animeListEntry.media) {
            e.next();
            return;
        }

        const media = e.animeListEntry.media;
        const localFile = e.localFile;

        const episodeNumber = localFile.metadata && typeof localFile.metadata.episode === "number"
            ? localFile.metadata.episode
            : 1;

        $store.set(STORE_PLAYBACK_KEY, {
            mediaId: localFile.mediaId,
            episodeNumber: episodeNumber,
            title: media.title?.userPreferred || media.title?.romaji || media.title?.english || "Unknown",
            image: media.coverImage?.extraLarge || media.coverImage?.large || "",
            isMovie: media.format === "MOVIE",
            totalEpisodes: typeof media.episodes === "number" ? media.episodes : 0,
            durationSeconds: (typeof media.duration === "number" ? media.duration : 24) * 60,
            triggeredAt: Date.now(),
        } satisfies ExtRpcPlaybackData);

        e.next();
    });

    $app.onPlaybackBeforeTracking((e) => {
        $store.set(STORE_STD_TRACKING_TS, Date.now());
        e.next();
    });

    $ui.register((ctx) => {
        let discordActive = false;
        let progressInterval: any = null;
        let monitorInterval: any = null;
        let startGraceTimeout: any = null;

        let activeMediaId: number | null = null;
        let syntheticProgress = 0;
        let syntheticDuration = 0;

        function clearTimers() {
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }

            if (monitorInterval) {
                clearInterval(monitorInterval);
                monitorInterval = null;
            }

            if (startGraceTimeout) {
                clearTimeout(startGraceTimeout);
                startGraceTimeout = null;
            }
        }

        function stopDiscordPresence() {
            clearTimers();

            if (discordActive) {
                try {
                    ctx.discord.cancel();
                } catch (err) {
                    console.error("[Ext RPC] Error canceling Discord:", err);
                }
            }

            discordActive = false;
            activeMediaId = null;
            syntheticProgress = 0;
            syntheticDuration = 0;
        }

        function getWatchHistoryItem(mediaId: number): any | null {
            try {
                const item = ctx.continuity.getWatchHistoryItem(mediaId);
                return item ?? null;
            } catch {
                return null;
            }
        }

        function extractProgressFromHistory(item: any, fallbackDuration: number) {
            const currentTime =
                typeof item?.currentTime === "number" && !Number.isNaN(item.currentTime)
                    ? Math.max(0, Math.floor(item.currentTime))
                    : null;

            const duration =
                typeof item?.duration === "number" && item.duration > 0 && !Number.isNaN(item.duration)
                    ? Math.floor(item.duration)
                    : fallbackDuration;

            const kind = typeof item?.kind === "string" ? item.kind : null;

            return { currentTime, duration, kind };
        }

        function startDiscordPresence(data: ExtRpcPlaybackData, initialProgress = 0, durationOverride?: number) {
            stopDiscordPresence();

            discordActive = true;
            activeMediaId = data.mediaId;
            syntheticProgress = initialProgress;
            syntheticDuration = typeof durationOverride === "number" && durationOverride > 0
                ? durationOverride
                : data.durationSeconds;

            try {
                ctx.discord.setAnimeActivity({
                    id: data.mediaId,
                    title: data.title,
                    image: data.image,
                    isMovie: data.isMovie,
                    episodeNumber: data.episodeNumber,
                    progress: syntheticProgress,
                    duration: syntheticDuration,
                    totalEpisodes: data.totalEpisodes > 0 ? data.totalEpisodes : undefined,
                });
            } catch (err) {
                console.error("[Ext RPC] Error setting Discord activity:", err);
                discordActive = false;
                activeMediaId = null;
                return;
            }

            progressInterval = setInterval(() => {
                if (!discordActive || activeMediaId !== data.mediaId) {
                    return;
                }

                const historyItem = getWatchHistoryItem(data.mediaId);
                const parsed = extractProgressFromHistory(historyItem, syntheticDuration);

                if (parsed.currentTime !== null) {
                    syntheticProgress = parsed.currentTime;
                    syntheticDuration = parsed.duration;
                } else {
                    syntheticProgress += 1;
                }

                try {
                    ctx.discord.updateAnimeActivity(
                        syntheticProgress,
                        syntheticDuration,
                        false
                    );
                } catch {
                    // Keep quiet; Seanime batches updates and transient failures are not fatal.
                }

                if (syntheticProgress >= syntheticDuration + 120) {
                    stopDiscordPresence();
                }
            }, 1000);
        }

        function startExternalMonitor(data: ExtRpcPlaybackData) {
            stopDiscordPresence();

            let started = false;
            let firstSeenAt = Date.now();

            monitorInterval = setInterval(() => {
                const stdTrackingTs = $store.get<number>(STORE_STD_TRACKING_TS);
                if (stdTrackingTs) {
                    stopDiscordPresence();
                    return;
                }

                const historyItem = getWatchHistoryItem(data.mediaId);
                const parsed = extractProgressFromHistory(historyItem, data.durationSeconds);

                if (historyItem && (parsed.kind === "external_player" || parsed.currentTime !== null)) {
                    if (!started) {
                        startDiscordPresence(
                            data,
                            parsed.currentTime ?? 0,
                            parsed.duration
                        );
                        started = true;
                    }
                    return;
                }

                if (!started && Date.now() - firstSeenAt >= 5000) {
                    startDiscordPresence(data, 0, data.durationSeconds);
                    started = true;
                }
            }, 1000);

            startGraceTimeout = setTimeout(() => {
                if (!started && !$store.get<number>(STORE_STD_TRACKING_TS)) {
                    startDiscordPresence(data, 0, data.durationSeconds);
                    started = true;
                }
            }, 5000);
        }

        $store.watch<number>(STORE_STD_TRACKING_TS, (ts) => {
            if (!ts) {
                return;
            }

            stopDiscordPresence();
        });

        $store.watch<ExtRpcPlaybackData>(STORE_PLAYBACK_KEY, (data) => {
            if (!data) {
                return;
            }

            const currentStdTs = $store.get<number>(STORE_STD_TRACKING_TS);
            if (currentStdTs) {
                stopDiscordPresence();
                return;
            }

            startExternalMonitor(data);
        });

        const existing = $store.get<ExtRpcPlaybackData>(STORE_PLAYBACK_KEY);
        if (existing && !$store.get<number>(STORE_STD_TRACKING_TS)) {
            startExternalMonitor(existing);
        }
    });
}

export {};
