
"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

const SUPPORT_EMAIL = "arbaaazkhanark23@gmail.com";

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("General question");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const subject = `[ReelQueue Support] ${topic}`;
    const body = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Topic: ${topic}`,
      "",
      "Message:",
      message,
    ].join("\n");

    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;

    window.location.href = mailto;
  }

  return (
    <main className="min-h-screen bg-[#f7f4ed] px-5 py-8 text-[#25231f] sm:px-8 sm:py-12">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-center justify-between gap-4 border-b border-[#ded8cc] pb-6">
          <Link
            href="/"
            className="text-xl font-bold tracking-tight text-[#b94f2d] sm:text-2xl"
          >
            ReelQueue<span className="text-[#25231f]">.</span>
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
            Contact & support
          </p>

          <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            Let&apos;s get things sorted.
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-7 text-[#625d54] sm:text-lg">
            Need help with your account, a connected service, or a scheduled
            post? Send us the details and we&apos;ll help you find the next step.
          </p>
        </section>

        <div className="grid gap-6 md:grid-cols-[0.8fr_1.2fr]">
          <aside className="rounded-2xl bg-[#25231f] p-6 text-[#f7f4ed] sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#e8a184]">
              Get in touch
            </p>

            <h2 className="mt-4 text-2xl font-bold">
              How can we help?
            </h2>

            <p className="mt-3 text-sm leading-6 text-[#d0c9bc]">
              For support, privacy questions, or account deletion requests,
              email us directly.
            </p>

            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-6 inline-block break-all text-sm font-semibold text-[#f2b49b] underline decoration-[#b94f2d] underline-offset-4 hover:text-white"
            >
              {SUPPORT_EMAIL}
            </a>

            <div className="my-7 border-t border-white/15" />

            <h3 className="text-sm font-semibold">Helpful links</h3>

            <nav className="mt-3 flex flex-col gap-3 text-sm text-[#d0c9bc]">
              <Link className="hover:text-white" href="/privacy">
                Privacy Policy →
              </Link>
              <Link className="hover:text-white" href="/terms">
                Terms of Service →
              </Link>
            </nav>
          </aside>

          <section className="rounded-2xl border border-[#e5ded2] bg-white/70 p-5 sm:p-8">
            <h2 className="text-2xl font-bold">Send a message</h2>
            <p className="mt-2 text-sm leading-6 text-[#625d54]">
              Fill in the details below. Your default email application will
              open with the message prepared for you to send.
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-5">
              <div>
                <label
                  htmlFor="contact-name"
                  className="mb-2 block text-sm font-semibold"
                >
                  Your name
                </label>
                <input
                  id="contact-name"
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full rounded-xl border border-[#ded8cc] bg-[#fdfbf7] px-4 py-3 text-sm outline-none transition placeholder:text-[#999184] focus:border-[#b94f2d] focus:ring-2 focus:ring-[#b94f2d]/15"
                  placeholder="Enter your name"
                />
              </div>

              <div>
                <label
                  htmlFor="contact-email"
                  className="mb-2 block text-sm font-semibold"
                >
                  Email address
                </label>
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-xl border border-[#ded8cc] bg-[#fdfbf7] px-4 py-3 text-sm outline-none transition placeholder:text-[#999184] focus:border-[#b94f2d] focus:ring-2 focus:ring-[#b94f2d]/15"
                  placeholder="you@example.com"
                />
              </div>

              <div>
                <label
                  htmlFor="contact-topic"
                  className="mb-2 block text-sm font-semibold"
                >
                  What is this about?
                </label>
                <select
                  id="contact-topic"
                  name="topic"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  className="w-full rounded-xl border border-[#ded8cc] bg-[#fdfbf7] px-4 py-3 text-sm outline-none transition focus:border-[#b94f2d] focus:ring-2 focus:ring-[#b94f2d]/15"
                >
                  <option>General question</option>
                  <option>Account or login</option>
                  <option>Instagram connection</option>
                  <option>Google Drive connection</option>
                  <option>Scheduled post or publishing issue</option>
                  <option>Privacy or data deletion</option>
                  <option>Report a security issue</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="contact-message"
                  className="mb-2 block text-sm font-semibold"
                >
                  Message
                </label>
                <textarea
                  id="contact-message"
                  name="message"
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={5}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  className="w-full resize-y rounded-xl border border-[#ded8cc] bg-[#fdfbf7] px-4 py-3 text-sm outline-none transition placeholder:text-[#999184] focus:border-[#b94f2d] focus:ring-2 focus:ring-[#b94f2d]/15"
                  placeholder="Tell us what happened and what you need help with..."
                />
              </div>

              {error && (
                <p role="alert" className="text-sm text-red-700">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="w-full rounded-xl bg-[#b94f2d] px-5 py-3.5 text-sm font-bold text-white transition hover:bg-[#963d22] focus:outline-none focus:ring-2 focus:ring-[#b94f2d] focus:ring-offset-2"
              >
                Prepare email →
              </button>

              <p className="text-xs leading-5 text-[#777064]">
                This form opens your email application. It does not send or
                store a message on ReelQueue&apos;s servers. Do not include
                passwords, access tokens, or other secrets.
              </p>
            </form>
          </section>
        </div>

        <footer className="flex flex-col gap-4 border-t border-[#ded8cc] py-8 mt-8 text-sm text-[#625d54] sm:flex-row sm:items-center sm:justify-between">
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
