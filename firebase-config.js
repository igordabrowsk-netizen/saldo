// Konfiguracja bazy danych w chmurze (Firebase, projekt „saldo”).
// To publiczne identyfikatory projektu (nie hasło) — dostęp do danych chronią reguły bezpieczeństwa
// w Firestore: każdy zalogowany użytkownik widzi wyłącznie swoje dane (users/{uid}/...).
window.SALDO_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCrUg0V2cOJEjIPOOpeijCkOYmqBKEQOGY',
  authDomain: 'saldo-d2887.firebaseapp.com',
  projectId: 'saldo-d2887',
  storageBucket: 'saldo-d2887.firebasestorage.app',
  messagingSenderId: '656003199459',
  appId: '1:656003199459:web:fe9d010686b86946a070d6'
};
