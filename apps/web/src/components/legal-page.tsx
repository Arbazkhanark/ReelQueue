
import Image from "next/image";
import Link from "next/link";

type LegalSection = {
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

type LegalPageProps = {
  label: string;
  title: string;
  description: string;
  lastUpdated: string;
  sections: LegalSection[];
};

export default function LegalPage({
  label,
  title,
  description,
  lastUpdated,
  sections,
}: LegalPageProps) {
  return (
    <main className="min-h-screen bg-[#f7f4ed] px-5 py-8 text-[#25231f] sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between gap-4 border-b border-[#ded8cc] pb-6">
          {/* <Link
            href="/"
            className="text-xl font-bold tracking-tight text-[#b94f2d] sm:text-2xl"
          >
            ReelQueue<span className="text-[#25231f]">.</span>
          </Link> */}
          <Link href="/" aria-label="ReelQueue home" className="inline-flex items-center">
            <Image
                src="/reelqueue-logo.svg"
                alt="ReelQueue"
                width={240}
                height={56}
                priority
                className="h-auto w-48 sm:w-56"
            />
          </Link>

          <Link
            href="/"
            className="text-sm font-medium text-[#625d54] transition hover:text-[#b94f2d]"
          >
            ← Back to home
          </Link>
        </header>

        <section className="pb-8 pt-12 sm:pb-12 sm:pt-16">
          <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[#b94f2d]">
            {label}
          </p>

          <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            {title}
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-[#625d54] sm:text-lg">
            {description}
          </p>

          <p className="mt-5 text-xs text-[#777064]">
            Last updated: {lastUpdated}
          </p>
        </section>

        <div className="rounded-2xl border border-[#e5ded2] bg-white/70 p-5 sm:p-9">
          <div className="space-y-9">
            {sections.map((section, index) => (
              <section key={section.title}>
                <h2 className="mb-3 text-xl font-bold tracking-tight sm:text-2xl">
                  <span className="mr-3 text-sm font-semibold text-[#b94f2d]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {section.title}
                </h2>

                <div className="space-y-3 text-sm leading-7 text-[#514c44] sm:text-base">
                  {section.paragraphs.map((paragraph, paragraphIndex) => (
                    <p key={paragraphIndex}>{paragraph}</p>
                  ))}

                  {section.bullets && (
                    <ul className="list-disc space-y-2 pl-6">
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>

        <footer className="flex flex-col gap-4 border-t border-[#ded8cc] py-8 text-sm text-[#625d54] sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} ReelQueue</p>

          <nav className="flex gap-5">
            <Link className="hover:text-[#b94f2d]" href="/privacy">
              Privacy
            </Link>
            <Link className="hover:text-[#b94f2d]" href="/terms">
              Terms
            </Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}
