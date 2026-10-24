// Публічні налаштування Firebase (це НЕ секрет: доступ до даних захищають Firestore Rules + вхід через Google).
window.APP_CONFIG = {
  FIREBASE: {
    apiKey: "AIzaSyCpRa4FN2TpJNh7ZorPemcnn1QMn9-UmiM",
    authDomain: "contrabas-crm.firebaseapp.com",
    projectId: "contrabas-crm",
    storageBucket: "contrabas-crm.firebasestorage.app",
    messagingSenderId: "495105581519",
    appId: "1:495105581519:web:7c541f638b0a6ee81372ba"
  },
  // Лише цей акаунт бачить дані (так само прописано в firestore.rules)
  OWNER_EMAIL: "vladpetrenko66@gmail.com",
  // Курс за замовчуванням; змінюється у вкладці «Тарифи та ціни» і зберігається в базі
  UAH_RATE: 50.795
};
