"""
Standalone Speaker Identification Module for Rie-AI using Sherpa-ONNX.
"""

from .model import SpeakerModel, cosine_similarity, load_wav_file

__all__ = ["SpeakerModel", "cosine_similarity", "load_wav_file"]
