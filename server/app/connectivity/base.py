from abc import ABC, abstractmethod
from typing import Dict, Optional


class ConnectivityPlugin(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def is_available(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def resolve(self, peer: Dict[str, str]) -> Optional[str]:
        raise NotImplementedError
