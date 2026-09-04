import firebaseConfig from '../firebase-applet-config.json';

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
    id: firebaseConfig.projectId || "gen-lang-client-0624437496",
    name: "Banco Oficial (Google Cloud Firestore)",
    badge: "Cloud Principal (Ativo)",
    badgeColor: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    description: `Banco Oficial (${firebaseConfig.firestoreDatabaseId || "(default)"})`,
    config: {
      projectId: firebaseConfig.projectId,
      appId: firebaseConfig.appId,
      apiKey: firebaseConfig.apiKey,
      authDomain: firebaseConfig.authDomain,
      firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
      storageBucket: firebaseConfig.storageBucket,
      messagingSenderId: firebaseConfig.messagingSenderId,
      measurementId: firebaseConfig.measurementId || "",
      oAuthClientId: firebaseConfig.oAuthClientId || ""
    }
  },
  {
    id: "banco-03-teste",
    name: "Banco 03 Teste (Secundário)",
    badge: "Banco 03 Teste",
    badgeColor: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
    description: "banco-03-teste (Banco Secundário / Testes)",
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
  if (projectId && FIREBASE_PRESETS.some(p => p.id === projectId || p.config.projectId === projectId)) {
    return projectId;
  }
  return FIREBASE_PRESETS[0].id;
}

