/**
 * Hover-to-scrub video preview on gallery card covers.
 */
export function setupGalleryVideoScrub(coverEl: HTMLElement, videoUrl: string): void {
  coverEl.style.position = "relative";
  coverEl.classList.add("roost-card-scrub");

  const video = document.createElement("video");
  video.src = videoUrl;
  video.preload = "metadata";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.className = "roost-scrub-video";
  coverEl.appendChild(video);

  const bar = document.createElement("div");
  bar.className = "roost-scrub-bar";
  const fill = document.createElement("div");
  fill.className = "roost-scrub-bar-fill";
  bar.appendChild(fill);
  coverEl.appendChild(bar);

  let hovering = false;
  let scrubEnabled = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let progressRaf = 0;

  const updateProgress = () => {
    if (!hovering) return;
    if (video.duration && isFinite(video.duration)) {
      fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
    }
    progressRaf = requestAnimationFrame(updateProgress);
  };

  coverEl.addEventListener("mouseenter", () => {
    if (video.readyState < 1) return;
    hovering = true;
    scrubEnabled = false;
    video.classList.add("roost-scrub-active");
    video.currentTime = 0;
    video.play().catch(() => {});
    progressRaf = requestAnimationFrame(updateProgress);
    requestAnimationFrame(() => { scrubEnabled = true; });
  });

  coverEl.addEventListener("mousemove", (e: MouseEvent) => {
    if (!hovering || !scrubEnabled || video.readyState < 1) return;
    if (!isFinite(video.duration) || video.duration === 0) return;

    video.pause();
    const rect = coverEl.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * video.duration;
    fill.style.width = `${pct * 100}%`;

    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (hovering) video.play().catch(() => {});
    }, 300);
  });

  coverEl.addEventListener("mouseleave", () => {
    hovering = false;
    scrubEnabled = false;
    cancelAnimationFrame(progressRaf);
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    video.pause();
    video.classList.remove("roost-scrub-active");
  });
}
