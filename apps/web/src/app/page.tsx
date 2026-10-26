// // apps/web/src/app/page.tsx
// import { redirect } from 'next/navigation';

// export default function Home() {
//   redirect('/dashboard');
// }



import LandingPage from '@/components/landing-page';

export default function Home() {
  return <LandingPage />;
}
