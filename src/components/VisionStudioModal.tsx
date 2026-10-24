import React, { useState, useRef } from 'react';
import { X, Image, Sparkles, Upload, Download, RefreshCw, Wand2, Eye, Sliders, CheckCircle, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { VisionAspectRatio, VisionQuality, VisionResolution } from '../types/commercial-types';

interface VisionStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  userCredits?: number;
  onCreditDeducted?: (credits: number) => void;
}

type VisionTab = 'understand' | 'generate' | 'edit';

export const VisionStudioModal: React.FC<VisionStudioModalProps> = ({
  isOpen,
  onClose,
  userCredits = 100,
  onCreditDeducted,
}) => {
  const [activeTab, setActiveTab] = useState<VisionTab>('generate');

  // Generation state
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<VisionAspectRatio>('1:1');
  const [resolution, setResolution] = useState<VisionResolution>('standard');
  const [quality, setQuality] = useState<VisionQuality>('economy');
  const [numImages, setNumImages] = useState<1 | 2>(1);

  // Understand state
  const [understandImage, setUnderstandImage] = useState<string | null>(null);
  const [understandQuestion, setUnderstandQuestion] = useState('');
  const [understandAnswer, setUnderstandAnswer] = useState<string | null>(null);

  // Edit state
  const [editSourceImage, setEditSourceImage] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editQuality, setEditQuality] = useState<VisionQuality>('economy');
  const [editResolution, setEditResolution] = useState<VisionResolution>('standard');

  // Execution state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedResults, setGeneratedResults] = useState<{
    images: Array<{ url: string; width: number; height: number }>;
    creditsCharged: number;
    prompt: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // Calculate tariff
  const calculateGenerateCost = () => {
    let perImage = 12;
    if (quality === 'economy' && resolution === 'standard') perImage = 12;
    else if (quality === 'economy' && resolution === 'high') perImage = 24;
    else if (quality === 'premium' && resolution === 'standard') perImage = 100;
    else if (quality === 'premium' && resolution === 'high') perImage = 125;
    return perImage * numImages;
  };

  const calculateEditCost = () => {
    if (editQuality === 'economy' && editResolution === 'standard') return 40;
    if (editQuality === 'economy' && editResolution === 'high') return 80;
    if (editQuality === 'premium' && editResolution === 'standard') return 130;
    return 250;
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>, target: 'understand' | 'edit') => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        if (target === 'understand') {
          setUnderstandImage(reader.result);
        } else {
          setEditSourceImage(reader.result);
        }
      }
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/vision/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          prompt,
          aspectRatio,
          resolution,
          quality,
          numImages
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Vision generation failed');
      }
      setGeneratedResults({
        images: data.images,
        creditsCharged: data.creditsCharged,
        prompt
      });
      if (onCreditDeducted) onCreditDeducted(data.creditsCharged);
    } catch (err: any) {
      setError(err.message || 'Error executing image generation');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnderstand = async () => {
    if (!understandImage) return;
    setIsLoading(true);
    setError(null);
    setUnderstandAnswer(null);
    try {
      const res = await fetch('/api/vision/understand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          imageUrl: understandImage,
          question: understandQuestion || 'Describe this image in detail and extract all key visual elements and text.'
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Vision analysis failed');
      }
      setUnderstandAnswer(data.analysis);
      if (onCreditDeducted && data.creditsCharged) onCreditDeducted(data.creditsCharged);
    } catch (err: any) {
      setError(err.message || 'Error analyzing visual content');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEdit = async () => {
    if (!editSourceImage || !editPrompt.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/vision/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sourceImageUrl: editSourceImage,
          instruction: editPrompt,
          quality: editQuality,
          resolution: editResolution
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Vision edit failed');
      }
      setGeneratedResults({
        images: data.images,
        creditsCharged: data.creditsCharged,
        prompt: `Edit: ${editPrompt}`
      });
      if (onCreditDeducted) onCreditDeducted(data.creditsCharged);
    } catch (err: any) {
      setError(err.message || 'Error executing visual edit');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="relative w-full max-w-4xl rounded-3xl bg-[#161618] border border-white/10 text-white shadow-2xl overflow-hidden my-6 flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="p-5 md:p-6 border-b border-white/10 flex items-center justify-between shrink-0 bg-stone-900/40">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-md">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-medium tracking-tight text-white flex items-center gap-2">
                AIRA Vision Studio
                <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Multimodal
                </span>
              </h2>
              <p className="text-xs text-stone-400">High-fidelity visual reasoning, diffusion generation, and semantic editing</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right hidden sm:block">
              <div className="text-[11px] text-stone-400">Wallet Balance</div>
              <div className="text-sm font-semibold text-emerald-400">{userCredits.toLocaleString()} Credits</div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-stone-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-white/10 bg-black/20 px-6 shrink-0">
          <button
            onClick={() => setActiveTab('generate')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'generate'
                ? 'border-[#cc785c] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Wand2 className="w-3.5 h-3.5" />
            Generate Images
          </button>
          <button
            onClick={() => setActiveTab('understand')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'understand'
                ? 'border-[#cc785c] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            Vision Understand & OCR
          </button>
          <button
            onClick={() => setActiveTab('edit')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'edit'
                ? 'border-[#cc785c] text-white'
                : 'border-transparent text-stone-400 hover:text-white'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            Vision Edit & Inpaint
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {activeTab === 'generate' && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1.5">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="A cinematic aerial view of a sustainable futuristic city in the Himalayas at dusk, hyperrealistic, 8k..."
                  rows={3}
                  className="w-full text-xs rounded-xl bg-stone-900 border border-white/10 p-3 text-white placeholder-stone-500 focus:outline-none focus:border-[#cc785c] transition-all resize-none"
                />
              </div>

              {/* Controls Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                {/* Aspect Ratio */}
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Aspect Ratio</label>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value as VisionAspectRatio)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value="1:1">Square 1:1 (1024×1024)</option>
                    <option value="3:4">Portrait 3:4 (896×1152)</option>
                    <option value="16:9">Landscape 16:9 (1344×768)</option>
                  </select>
                </div>

                {/* Resolution */}
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Resolution</label>
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value as VisionResolution)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value="standard">Standard</option>
                    <option value="high">High Definition</option>
                  </select>
                </div>

                {/* Quality Tier */}
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Model Tier</label>
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value as VisionQuality)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value="economy">Economy (Fast Diffusion)</option>
                    <option value="premium">Premium (Ultra FLUX/SDXL)</option>
                  </select>
                </div>

                {/* Number of Images */}
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Batch Count</label>
                  <select
                    value={numImages}
                    onChange={(e) => setNumImages(Number(e.target.value) as 1 | 2)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value={1}>1 Image</option>
                    <option value={2}>2 Images</option>
                  </select>
                </div>
              </div>

              {/* Action Bar */}
              <div className="flex items-center justify-between pt-2 border-t border-white/10">
                <div className="text-xs text-stone-400 flex items-center gap-2">
                  <span>Authorized Cost:</span>
                  <span className="font-semibold text-amber-400">{calculateGenerateCost()} Credits</span>
                  <span className="text-stone-500">(${(calculateGenerateCost() * 0.001).toFixed(3)})</span>
                </div>

                <button
                  onClick={handleGenerate}
                  disabled={isLoading || !prompt.trim()}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#cc785c] to-[#eb6e4b] text-white text-xs font-semibold shadow-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Synthesizing...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-3.5 h-3.5" />
                      Generate Vision Output
                    </>
                  )}
                </button>
              </div>

              {/* Generated Results */}
              {generatedResults && (
                <div className="mt-6 p-4 rounded-2xl bg-black/30 border border-white/10 space-y-4">
                  <div className="flex items-center justify-between text-xs text-stone-400">
                    <span>Result for: &quot;{generatedResults.prompt}&quot;</span>
                    <span className="text-emerald-400 font-medium">Settled: {generatedResults.creditsCharged} credits</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {generatedResults.images.map((img, idx) => (
                      <div key={idx} className="relative group rounded-xl overflow-hidden border border-white/10 bg-stone-900">
                        <img src={img.url} alt="Generated result" className="w-full h-auto object-cover" />
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                          <a
                            href={img.url}
                            target="_blank"
                            rel="noreferrer"
                            download={`aira-vision-${idx + 1}.png`}
                            className="p-2.5 rounded-xl bg-white/20 hover:bg-white/30 text-white backdrop-blur-sm transition-all"
                            title="Download Image"
                          >
                            <Download className="w-4 h-4" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'understand' && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1.5">Input Image</label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full h-40 border-2 border-dashed border-white/15 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:border-[#cc785c]/50 transition-colors bg-stone-900/40 relative overflow-hidden"
                >
                  {understandImage ? (
                    <img src={understandImage} alt="Uploaded for inspection" className="h-full w-auto object-contain" />
                  ) : (
                    <div className="text-center p-4">
                      <Upload className="w-6 h-6 text-stone-400 mx-auto mb-2" />
                      <div className="text-xs text-stone-300 font-medium">Click to upload an image or chart</div>
                      <div className="text-[10px] text-stone-500 mt-0.5">Supports PNG, JPG, WebP up to 10MB</div>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImageUpload(e, 'understand')}
                    className="hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1.5">Question or OCR Goal</label>
                <input
                  type="text"
                  value={understandQuestion}
                  onChange={(e) => setUnderstandQuestion(e.target.value)}
                  placeholder="Extract data from this chart, or describe specific anomalies..."
                  className="w-full text-xs rounded-xl bg-stone-900 border border-white/10 p-3 text-white placeholder-stone-500 focus:outline-none focus:border-[#cc785c]"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/10">
                <div className="text-xs text-stone-400">
                  <span>Authorized Cost: </span>
                  <span className="font-semibold text-amber-400">10 Credits</span>
                </div>

                <button
                  onClick={handleUnderstand}
                  disabled={isLoading || !understandImage}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-xs font-semibold shadow-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                  Analyze Image
                </button>
              </div>

              {understandAnswer && (
                <div className="p-4 rounded-2xl bg-stone-900/80 border border-white/10 text-xs text-stone-300 leading-relaxed whitespace-pre-wrap">
                  <div className="font-semibold text-white mb-2 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-400" />
                    Vision Analysis Result
                  </div>
                  {understandAnswer}
                </div>
              )}
            </div>
          )}

          {activeTab === 'edit' && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1.5">Source Image</label>
                <div
                  onClick={() => editFileInputRef.current?.click()}
                  className="w-full h-40 border-2 border-dashed border-white/15 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:border-[#cc785c]/50 transition-colors bg-stone-900/40 relative overflow-hidden"
                >
                  {editSourceImage ? (
                    <img src={editSourceImage} alt="Source for editing" className="h-full w-auto object-contain" />
                  ) : (
                    <div className="text-center p-4">
                      <Upload className="w-6 h-6 text-stone-400 mx-auto mb-2" />
                      <div className="text-xs text-stone-300 font-medium">Upload image to edit / inpaint</div>
                    </div>
                  )}
                  <input
                    ref={editFileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImageUpload(e, 'edit')}
                    className="hidden"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-300 mb-1.5">Edit Instruction</label>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder="Change the background to a sunset beach and add warm cinematic lighting..."
                  rows={2}
                  className="w-full text-xs rounded-xl bg-stone-900 border border-white/10 p-3 text-white placeholder-stone-500 focus:outline-none focus:border-[#cc785c] resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Quality</label>
                  <select
                    value={editQuality}
                    onChange={(e) => setEditQuality(e.target.value as VisionQuality)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value="economy">Economy (40 Credits)</option>
                    <option value="premium">Premium (130 Credits)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-stone-400 mb-1">Resolution</label>
                  <select
                    value={editResolution}
                    onChange={(e) => setEditResolution(e.target.value as VisionResolution)}
                    className="w-full text-xs rounded-lg bg-stone-900 border border-white/10 p-2 text-white focus:outline-none"
                  >
                    <option value="standard">Standard</option>
                    <option value="high">High Definition</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-white/10">
                <div className="text-xs text-stone-400">
                  <span>Authorized Cost: </span>
                  <span className="font-semibold text-amber-400">{calculateEditCost()} Credits</span>
                </div>

                <button
                  onClick={handleEdit}
                  disabled={isLoading || !editSourceImage || !editPrompt.trim()}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-[#cc785c] to-[#eb6e4b] text-white text-xs font-semibold shadow-lg hover:brightness-110 active:scale-95 transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sliders className="w-3.5 h-3.5" />}
                  Execute Visual Edit
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
};
