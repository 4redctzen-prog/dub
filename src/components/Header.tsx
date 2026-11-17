interface HeaderProps {
  hasActiveJob: boolean;
  onResetProject: () => void;
  onTriggerUpload: () => void;
}

export function Header({ hasActiveJob, onResetProject, onTriggerUpload }: HeaderProps) {
  return (
    <header className="border-b border-white/[0.08] bg-[#0B0D11]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-8 px-6 py-4">
        <a
          href="#studio"
          className="font-display text-lg font-semibold tracking-tight text-[#F1F3F5] whitespace-nowrap shrink-0"
        >
          Resonance Dub
        </a>

        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#9BA3B0]">
          <a
            href="#upload-section"
            className="hover:text-[#F1F3F5] transition-colors whitespace-nowrap shrink-0"
          >
            Source Audio
          </a>
          <a
            href="#languages-section"
            className="hover:text-[#F1F3F5] transition-colors whitespace-nowrap shrink-0"
          >
            Languages
          </a>
          <a
            href="#settings-section"
            className="hover:text-[#F1F3F5] transition-colors whitespace-nowrap shrink-0"
          >
            Preservation
          </a>
          <a
            href="#output-section"
            className="hover:text-[#F1F3F5] transition-colors whitespace-nowrap shrink-0"
          >
            Outputs & SRT
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          {hasActiveJob ? (
            <button
              type="button"
              onClick={onResetProject}
              className="min-h-[40px] rounded-lg border border-white/[0.14] bg-[#141820] px-4 py-2 text-sm font-medium text-[#F1F3F5] transition-colors hover:border-white/[0.26] hover:bg-[#1A1F2A] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#E5A93C]"
            >
              Start New Project
            </button>
          ) : (
            <button
              type="button"
              onClick={onTriggerUpload}
              className="min-h-[40px] rounded-lg bg-[#E5A93C] px-4 py-2 text-sm font-semibold text-[#0B0D11] transition-colors hover:bg-[#EEB854] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#E5A93C]"
            >
              Upload Audio
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
