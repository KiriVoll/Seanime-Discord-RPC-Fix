/// <reference path="./plugin.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

// Оборачиваем в IIFE, чтобы изолировать область видимости
(function () {
    // ═══════════════════════════════════════════════════════════
    // HOOK LAYER — серверная сторона Seanime
    // ═══════════════════════════════════════════════════════════

    $app.onPlaybackLocalFileDetailsRequested((e) => {
        if (!e.localFile || !e.animeListEntry || !e.animeListEntry.media) {
            e.next();
            return;
        }

        const media = e.animeListEntry.media;
        const localFile = e.localFile;

        $store.set("ext_rpc_playback", {
            mediaId: localFile.mediaId,
            episodeNumber: localFile.metadata ? localFile.metadata.episode : 1,
            title: media.title?.userPreferred || media.title?.romaji || media.title?.english || "Unknown",
            image: media.coverImage?.extraLarge || media.coverImage?.large || "",
            isMovie: media.format === "MOVIE",
            totalEpisodes: media.episodes || 0,
            durationSeconds: (media.duration || 24) * 60,
            triggeredAt: Date.now(),
        });

        e.next();
    });

    $app.onPlaybackBeforeTracking((e) => {
        // Сигнал, что стандартный плеер (ПК) начал работу
        $store.set("ext_rpc_std_tracking_ts", Date.now());
        e.next();
    });

    // ═══════════════════════════════════════════════════════════
    // UI LAYER — браузерный контекст
    // ═══════════════════════════════════════════════════════════

    $ui.register((ctx) => {
        let discordActive = false;
        let progressInterval: any = null;
        let startTimeout: any = null;
        let currentDuration = 0;
        let currentProgress = 0;

        function stopDiscordPresence() {
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            if (startTimeout) {
                clearTimeout(startTimeout);
                startTimeout = null;
            }
            if (discordActive) {
                try {
                    ctx.discord.cancel();
                } catch (err) {
                    console.error("[Ext RPC] Error canceling Discord:", err);
                }
                discordActive = false;
            }
            currentProgress = 0;
            currentDuration = 0;
        }

        function startDiscordPresence(data: any) {
            stopDiscordPresence();
            
            discordActive = true;
            currentProgress = 0;
            currentDuration = data.durationSeconds as number;

            try {
                ctx.discord.setAnimeActivity({
                    id: data.mediaId,
                    title: data.title,
                    image: data.image,
                    isMovie: data.isMovie,
                    episodeNumber: data.episodeNumber,
                    progress: 0,
                    duration: currentDuration,
                    totalEpisodes: data.totalEpisodes > 0 ? data.totalEpisodes : undefined,
                });
            } catch (err) {
                console.error("[Ext RPC] Error setting activity:", err);
                discordActive = false;
                return;
            }

            progressInterval = setInterval(() => {
                if (!discordActive) return;

                currentProgress++;

                try {
                    ctx.discord.updateAnimeActivity(currentProgress, currentDuration, false);
                } catch (err) {
                    // Игнорируем ошибки при обновлении, чтобы не спамить в консоль
                }

                // Авто-стоп через 2 минуты после окончания предполагаемой длительности
                if (currentProgress >= currentDuration + 120) {
                    stopDiscordPresence();
                }
            }, 1000);
        }

        // ── Watchers ───────────────────────────────────────────

        $store.watch("ext_rpc_std_tracking_ts", (ts) => {
            if (!ts) return;
            // Если сработал стандартный плеер - убиваем наш таймер запуска и статус
            if (startTimeout) {
                clearTimeout(startTimeout);
                startTimeout = null;
            }
            if (discordActive) {
                stopDiscordPresence();
            }
        });

        $store.watch("ext_rpc_playback", (data: any) => {
            if (!data) return;

            // Сбрасываем текущий статус при запросе нового файла
            stopDiscordPresence();

            // Даем стандартному плееру 4 секунды, чтобы перехватить воспроизведение
            startTimeout = setTimeout(() => {
                // Дополнительная проверка на активный VideoCore в браузере
                try {
                    if (ctx.videoCore && typeof ctx.videoCore.getCurrentPlaybackType === "function") {
                        const playbackType = ctx.videoCore.getCurrentPlaybackType();
                        if (playbackType && playbackType.length > 0) {
                            return; // Работает веб-плеер, отменяем запуск
                        }
                    }
                } catch (err) {
                    // VideoCore API недоступен, продолжаем
                }

                // Стандартный плеер так и не запустился за 4 секунды.
                // Значит это External Player / Direct Play. Включаем наш статус!
                startDiscordPresence(data);
            }, 4000); 
        });
    });
})();