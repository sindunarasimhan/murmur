import Head from 'expo-router/head';

import { LennyScreen } from '@/features/lenny/lenny-screen';

export default function HomeRoute() {
  return (
    <>
      <Head>
        <title>Murmur</title>
        <meta name="description" content="Murmur — a voice-first podcast experience." />
        <meta name="theme-color" content="#08090B" />
      </Head>
      <LennyScreen />
    </>
  );
}
