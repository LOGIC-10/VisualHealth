"use client";
import { useEffect, useState } from 'react';

export const dict = {
  en: {
    // Nav
    Analysis: 'Analysis',
    Community: 'Community',
    Login: 'Login',
    MyAnalysis: 'My Analysis',
    CreatePost: 'Create Post',
    Profile: 'Profile',
    Logout: 'Logout',
    // Home
    HomeHeroTitle: 'Hear your heart. Understand your health.',
    HomeHeroDesc: 'Upload heart sound recordings to visualize waveforms and spectrograms, extract insights, and share with a global community.',
    GetStarted: 'Get Started',
    ExploreCommunity: 'Explore Community',
    HeartSound101: 'Heart Sound 101',
    HeartSound101Desc: 'Heart sounds (S1, S2) arise from valve closures; murmurs may indicate turbulent flow. Visualizing waveforms and spectrograms helps contextualize intensity, timing, and frequency bands.',
    AboutVH: 'About VisualHealth',
    AboutVHDesc: 'An open, modular platform for heart sound analysis. Privacy-first storage, per-service data isolation, and a growing library of analysis modules.',
    // Auth
    LoginTitle: 'Login',
    SignupTitle: 'Sign up',
    Email: 'Email',
    Password: 'Password',
    DisplayName: 'Display name',
    CreateAccount: 'Create account',
    NoAccount: 'No account? Sign up',
    HaveAccount: 'Have an account? Login',
    // Analysis list/detail
    AnalysisTitle: 'Analysis',
    LoginToView: 'Please login to view your analysis history.',
    NewAnalysis: 'New Analysis',
    NoRecords: 'No analysis records yet.',
    Back: '← Back',
    Features: 'Features',
    Title: 'Title',
    EditTitle: 'Edit title',
    Duration: 'Duration (s)',
    SampleRate: 'Sample Rate',
    RMS: 'RMS',
    ZCR: 'ZCR (/s)',
    PeakRate: 'Peak Rate (/s)',
    SpectralCentroid: 'Spectral Centroid',
    Bandwidth: 'Bandwidth',
    Rolloff95: 'Rolloff 95%',
    Flatness: 'Flatness',
    Flux: 'Flux',
    CrestFactor: 'Crest Factor',
    Cancel: 'Cancel',
    Loading: 'Loading...',
    // Community
    CommunityTitle: 'Community',
    LoginToPost: 'Login to Post',
    NewPost: 'New Post',
    CreatePostTitle: 'Create Post',
    ShareStory: 'Share your story...',
    AddImages: 'Add Images',
    Post: 'Post',
    // Settings
    ProfileTitle: 'Profile',
    PleaseLoginManage: 'Please login to manage profile.',
    Save: 'Save',
  },
  zh: {
    // Nav
    Analysis: '分析记录',
    Community: '社区',
    Login: '登录',
    MyAnalysis: '我的分析',
    CreatePost: '发帖',
    Profile: '个人资料',
    Logout: '退出',
    // Home
    HomeHeroTitle: '听见心声，洞察健康',
    HomeHeroDesc: '上传心音录音以可视化波形与评谱图，提取特征并与全球社区分享。',
    GetStarted: '开始使用',
    ExploreCommunity: '探索社区',
    HeartSound101: '心音入门 101',
    HeartSound101Desc: '心音（S1、S2）源于瓣膜关闭；杂音提示湍流。可视化波形与评谱有助于理解强度、时序与频带。',
    AboutVH: '关于 VisualHealth',
    AboutVHDesc: '一个开放、模块化的心音分析平台。以隐私为先，服务级数据隔离，持续增长的分析模块库。',
    // Auth
    LoginTitle: '登录',
    SignupTitle: '注册',
    Email: '邮箱',
    Password: '密码',
    DisplayName: '昵称',
    CreateAccount: '创建账号',
    NoAccount: '没有账号？去注册',
    HaveAccount: '已有账号？去登录',
    // Analysis list/detail
    AnalysisTitle: '分析记录',
    LoginToView: '请登录后查看历史分析记录。',
    NewAnalysis: '新建分析',
    NoRecords: '还没有分析记录。',
    Back: '← 返回',
    Features: '特征',
    Title: '标题',
    EditTitle: '编辑标题',
    Duration: '时长（秒）',
    SampleRate: '采样率',
    RMS: '均方根（RMS）',
    ZCR: '过零率（次/秒）',
    PeakRate: '峰事件率（次/秒）',
    SpectralCentroid: '谱质心',
    Bandwidth: '带宽',
    Rolloff95: '95%谱衰减',
    Flatness: '谱平坦度',
    Flux: '谱流量',
    CrestFactor: '峰因子',
    Cancel: '取消',
    Loading: '加载中…',
    // Community
    CommunityTitle: '社区',
    LoginToPost: '登录后发帖',
    NewPost: '发布新贴',
    CreatePostTitle: '创建帖子',
    ShareStory: '分享你的故事…',
    AddImages: '添加图片',
    Post: '发布',
    // Settings
    ProfileTitle: '个人资料',
    PleaseLoginManage: '请登录后管理资料。',
    Save: '保存',
  }
};

export function useI18n() {
  const getLang = () => {
    if (typeof document !== 'undefined') {
      const d = document.documentElement.getAttribute('data-lang');
      if (d === 'zh' || d === 'en') return d;
    }
    try { const s = localStorage.getItem('vh_lang'); if (s === 'zh' || s === 'en') return s; } catch {}
    return 'en';
  };
  const [lang, setLang] = useState(getLang());
  useEffect(() => {
    function onChange(ev){ const v = ev?.detail || getLang(); setLang(v); }
    window.addEventListener('vh_lang_change', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('vh_lang_change', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  const t = (k) => (dict[lang] && dict[lang][k]) || dict.en[k] || k;
  return { lang, t };
}

export function setGlobalLang(lang) {
  if (lang !== 'en' && lang !== 'zh') return;
  try { localStorage.setItem('vh_lang', lang); } catch {}
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-lang', lang);
  const ev = new CustomEvent('vh_lang_change', { detail: lang });
  window.dispatchEvent(ev);
}
