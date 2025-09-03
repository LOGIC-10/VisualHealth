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
    HomeHeroDesc: 'Upload heart sound recordings to visualize waveforms and spectrograms, using algorithms to extract insights, and communicate with a global community.',
    GetStarted: 'Get Started',
    ExploreCommunity: 'Explore Community',
    HeartSound101: 'Heart Sound 101',
    HeartSound101Desc: 'Heart sounds (S1, S2) arise from valve closures; murmurs may indicate turbulent flow. Visualizing waveforms and spectrograms helps contextualize intensity, timing, and frequency bands.',
    AboutVH: 'About VisualHealth',
    AboutVHDesc: 'An open, modular platform for heart sound analysis. Privacy-first storage, per-service data isolation, and a growing library of analysis modules.',
    HomeFeaturesTitle: 'Why VisualHealth',
    Feat1Title: 'Clinical-grade PCG pipeline',
    Feat1Desc: 'S1/S2 segmentation, timing metrics, murmur energy and QC baselines.',
    Feat2Title: 'Privacy-first storage',
    Feat2Desc: 'Encrypted per-user media isolation with service-level separation.',
    Feat3Title: 'Interactive tools',
    Feat3Desc: 'Zoomable waveform, spectrogram, and instant playback for detail review.',
    Feat4Title: 'Community & sharing',
    Feat4Desc: 'Share anonymized insights and learn from global cases.',
    DemoTitle: 'Interactive Demo',
    DemoDesc: 'A synthetic heart sound to try zoom, pan, and spectrogram in your browser.',
    MedicalTitle: 'Medical Endorsement',
    MedicalDesc: 'Pre-screening methods inspired by PhysioNet community and peer-reviewed baselines. Collaborations to be announced.',
    CommunityHomeTitle: 'Community Stories',
    Story1: '“Thanks to VisualHealth, I could visualize changes during rehab.”',
    Story2: '“The spectrogram helped me understand my murmur pattern.”',
    Story3: '“Sharing anonymized recordings made discussions much clearer.”',
    FooterPrivacy: 'Privacy',
    FooterTeam: 'Team',
    FooterFAQ: 'FAQ',
    PrivacyText: 'We value privacy. Your recordings are stored with per-user isolation and can be deleted anytime.',
    TeamText: 'We are an interdisciplinary team spanning signal processing and clinical workflows.',
    FAQText: 'Questions? Reach out and we will add answers here.',
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
    Waveform: 'Waveform',
    Spectrogram: 'Spectrogram',
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
    ClinicalAnalysis: 'Clinical PCG Analysis',
    Segmentation: 'Segmentation',
    HeartRate: 'Heart Rate (bpm)',
    RRMean: 'RR mean (s)',
    RRStd: 'RR std (s)',
    Systole: 'Systole (ms)',
    Diastole: 'Diastole (ms)',
    DSRatio: 'D/S ratio',
    S2Split: 'S2 split (A2–P2, ms)',
    A2OS: 'A2–OS (ms)',
    S1Intensity: 'S1 intensity',
    S2Intensity: 'S2 intensity',
    Murmur: 'Murmur metrics',
    SysHF: 'Systolic HF energy',
    DiaHF: 'Diastolic HF energy',
    SysShape: 'Systolic shape',
    QC: 'Quality control',
    SNR: 'SNR (dB)',
    MotionPct: 'Motion/resp artifacts (%)',
    UsablePct: 'Usable time (%)',
    Disclaimer: 'Disclaimer: This tool provides screening-grade PCG analysis based on established signal processing baselines (e.g., Springer segmentation). It is not a medical device and not a substitute for clinical diagnosis. Please consult echocardiography and clinical judgement for final decisions.',
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
    HomeHeroDesc: '上传心音录音以可视化波形与频谱图，算法分析心音特征，在全球社区交流分享。',
    GetStarted: '开始使用',
    ExploreCommunity: '探索社区',
    HeartSound101: '心音入门 101',
    HeartSound101Desc: '心音（S1、S2）源于瓣膜关闭；杂音提示湍流。可视化波形与评谱有助于理解强度、时序与频带。',
    AboutVH: '关于 VisualHealth',
    AboutVHDesc: '一个开放、模块化的心音分析平台。以隐私为先，服务级数据隔离，持续增长的分析模块库。',
    HomeFeaturesTitle: '为何选择 VisualHealth',
    Feat1Title: '临床级 PCG 流程',
    Feat1Desc: 'S1/S2 分割、时距学指标、杂音能量与质量控制基线。',
    Feat2Title: '隐私优先的存储',
    Feat2Desc: '加密的用户级媒体隔离，服务级数据分离。',
    Feat3Title: '交互式工具',
    Feat3Desc: '可缩放波形、频谱与即时播放，便于细节查看。',
    Feat4Title: '社区与分享',
    Feat4Desc: '匿名分享见解，与全球案例共同学习。',
    DemoTitle: '交互式演示',
    DemoDesc: '一段合成心音，直接在浏览器中体验缩放、平移与频谱。',
    MedicalTitle: '医学背书',
    MedicalDesc: '借鉴 PhysioNet 社区与同行评审基线的预筛查方法。合作机构敬请期待。',
    CommunityHomeTitle: '社区分享',
    Story1: '“多亏了 VisualHealth，我能直观对比康复过程变化。”',
    Story2: '“频谱图让我理解了我的杂音形态。”',
    Story3: '“匿名分享录音后，讨论清晰多了。”',
    FooterPrivacy: '隐私',
    FooterTeam: '团队',
    FooterFAQ: '常见问题',
    PrivacyText: '我们重视隐私。你的录音以用户级隔离存储，随时可删除。',
    TeamText: '团队来自信号处理与临床工作流程等跨学科背景。',
    FAQText: '有问题？欢迎联系我们，我们会补充常见问答。',
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
    Waveform: '波形图',
    Spectrogram: '频谱图',
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
    ClinicalAnalysis: '临床级 PCG 分析',
    Segmentation: '分割',
    HeartRate: '心率（次/分）',
    RRMean: 'RR均值（秒）',
    RRStd: 'RR标准差（秒）',
    Systole: '收缩期（毫秒）',
    Diastole: '舒张期（毫秒）',
    DSRatio: '舒/收比',
    S2Split: 'S2分裂（A2–P2，毫秒）',
    A2OS: 'A2–OS（毫秒）',
    S1Intensity: 'S1强度',
    S2Intensity: 'S2强度',
    Murmur: '杂音指标',
    SysHF: '收缩期高频能量',
    DiaHF: '舒张期高频能量',
    SysShape: '收缩期形态',
    QC: '质量控制',
    SNR: '信噪比（dB）',
    MotionPct: '体动/呼吸伪迹占比（%）',
    UsablePct: '可用时间占比（%）',
    Disclaimer: '免责声明：本工具基于经典的信号处理基线（如 Springer 分割）提供筛查级心音分析，非医疗器械，不能替代临床诊断。最终结论请以超声心动图与临床判断为准。',
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
