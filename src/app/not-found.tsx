export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-[46rem] flex-col items-start justify-center px-5 sm:px-6">
      <h1 className="font-display text-3xl tracking-[-0.01em] text-paper">Nothing here.</h1>
      <a
        href="/"
        className="mt-6 rounded-xl bg-paper px-4 py-2 text-[0.875rem] font-medium text-ink transition-opacity hover:opacity-90"
      >
        Back
      </a>
    </main>
  );
}
