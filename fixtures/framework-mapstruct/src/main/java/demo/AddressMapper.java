package demo;

import org.mapstruct.Mapper;

@Mapper
public interface AddressMapper {
  AddressResponse toResponse(AddressEntity source);
}
