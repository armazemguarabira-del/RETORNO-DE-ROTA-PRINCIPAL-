export interface FirebasePreset {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  description: string;
  config: {
    projectId: string;
    appId: string;
    apiKey: string;
    authDomain: string;
    firestoreDatabaseId: string;
    storageBucket: string;
    messagingSenderId: string;
    measurementId?: string;
    oAuthClientId?: string;
  };
}

export const FIREBASE_PRESETS: FirebasePreset[] = [
  {
    id: "banco-03-teste",
    name: "Banco 03 Teste (Banco Principal - Plataforma Completa e GitHub)",
    badge: "Banco 03 Teste (Ativo)",
    badgeColor: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    description: "banco-03-teste (Banco Único para Todos os Usuários e GitHub Pages)",
    config: {
      projectId: "banco-03-teste",
      appId: "1:960111862390:web:14e480b12d53eb9fb0b557",
      apiKey: "AIzaSyCRqq7FK0L9m_aEqte7BXCu5q0C68JbJ64",
      authDomain: "banco-03-teste.firebaseapp.com",
      firestoreDatabaseId: "(default)",
      storageBucket: "banco-03-teste.firebasestorage.app",
      messagingSenderId: "960111862390",
      measurementId: "",
      oAuthClientId: ""
    }
  }
];

export function getActivePresetId(projectId?: string): string {
  return "banco-03-teste";
}
